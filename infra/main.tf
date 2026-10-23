locals {
  use_custom_ssh_key = trimspace(var.ssh_public_key_path) != ""
  local_pi_auth_path = pathexpand("~/.pi/agent/auth.json")
  has_local_pi_auth  = var.sync_local_pi_auth && fileexists(local.local_pi_auth_path)

  ssh_public_key_content  = local.use_custom_ssh_key ? trimspace(file(pathexpand(var.ssh_public_key_path))) : trimspace(tls_private_key.generated[0].public_key_openssh)
  ssh_private_key_content = local.use_custom_ssh_key ? file(pathexpand(var.ssh_private_key_path)) : tls_private_key.generated[0].private_key_openssh
  ssh_private_key_file    = local.use_custom_ssh_key ? pathexpand(var.ssh_private_key_path) : local_sensitive_file.ssh_private_key[0].filename

  pi_settings_json = jsonencode({
    defaultProvider      = var.default_provider
    defaultModel         = var.default_model
    defaultThinkingLevel = var.default_thinking_level
    theme                = "light"
    hideThinkingBlock    = true
  })

  bot_pool_json = jsonencode({
    bots = [
      for b in var.bot_pool : {
        token       = b.token
        defaultName = b.default_name
      }
    ]
  })

  llm_env_content = join("\n", [
    for k, v in var.llm_env_vars : "export ${k}=${jsonencode(v)}"
  ])
}

# ─── 1. SSH Key Pair ─────────────────────────────────────────────────────────
resource "tls_private_key" "generated" {
  count     = local.use_custom_ssh_key ? 0 : 1
  algorithm = "ED25519"
}

resource "local_sensitive_file" "ssh_private_key" {
  count           = local.use_custom_ssh_key ? 0 : 1
  content         = tls_private_key.generated[0].private_key_openssh
  filename        = "${path.module}/keys/${var.project_name}.pem"
  file_permission = "0600"
}

resource "aws_lightsail_key_pair" "pi_key" {
  name       = "${var.project_name}-key"
  public_key = local.ssh_public_key_content
}

# ─── 2. Lightsail VM, Static IP & Firewall ───────────────────────────────────
resource "aws_lightsail_instance" "pi_vm" {
  name              = var.project_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = aws_lightsail_key_pair.pi_key.name

  user_data = templatefile("${path.module}/templates/cloud-init.sh.tftpl", {
    pi_version = var.pi_version
  })

  # Never destroy the VM (and its SQLite DB / project repos) when user_data template changes
  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "aws_lightsail_static_ip" "pi_ip" {
  name = "${var.project_name}-static-ip"
}

resource "aws_lightsail_static_ip_attachment" "pi_ip_attach" {
  static_ip_name = aws_lightsail_static_ip.pi_ip.name
  instance_name  = aws_lightsail_instance.pi_vm.name
}

resource "aws_lightsail_instance_public_ports" "pi_firewall" {
  instance_name = aws_lightsail_instance.pi_vm.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_allowed_cidrs
  }
}

# ─── 3. Deterministic Application Bundle ─────────────────────────────────────
data "archive_file" "app_bundle" {
  type        = "zip"
  source_dir  = "${path.module}/.."
  output_path = "${path.module}/.build/app-bundle.zip"

  excludes = [
    ".git",
    "node_modules",
    "infra",
    ".env",
    "bots-pool.json"
  ]
}

# ─── 4. In-Place Code & Config Sync (Runs on `terraform apply`) ──────────────
resource "terraform_data" "app_deploy" {
  depends_on = [
    aws_lightsail_static_ip_attachment.pi_ip_attach,
    aws_lightsail_instance_public_ports.pi_firewall
  ]

  triggers_replace = [
    aws_lightsail_instance.pi_vm.id,
    data.archive_file.app_bundle.output_sha256,
    var.pi_version,
    local.pi_settings_json,
    sha256(var.father_bot_token),
    var.allowed_telegram_user_id,
    sha256(local.bot_pool_json),
    sha256(local.llm_env_content),
    local.has_local_pi_auth ? filesha256(local.local_pi_auth_path) : "no-auth"
  ]

  connection {
    type        = "ssh"
    user        = "ubuntu"
    host        = aws_lightsail_static_ip.pi_ip.ip_address
    private_key = local.ssh_private_key_content
    timeout     = "5m"
  }

  # Wait for cloud-init bootstrap (Node 24 + Pi CLI + tmux + systemd unit) to finish
  provisioner "remote-exec" {
    inline = [
      "echo '[terraform] Waiting for cloud-init base setup to complete...'",
      "for i in $(seq 1 120); do [ -f /var/lib/cloud/pi-father-bootstrap-done ] && break; sleep 3; done",
      "[ -f /var/lib/cloud/pi-father-bootstrap-done ] || (echo 'cloud-init bootstrap timed out' && exit 1)",
      "mkdir -p /home/ubuntu/pi-father-spinner /home/ubuntu/.pi/agent/father-spinner/configs /home/ubuntu/projects"
    ]
  }

  # Upload the application archive
  provisioner "file" {
    source      = data.archive_file.app_bundle.output_path
    destination = "/tmp/pi-father-spinner-bundle.zip"
  }

  # Unpack, configure credentials/settings/pool, run tests, and reload systemd service
  provisioner "remote-exec" {
    inline = [
      "set -euo pipefail",
      "unzip -qo /tmp/pi-father-spinner-bundle.zip -d /home/ubuntu/pi-father-spinner",
      "rm -f /tmp/pi-father-spinner-bundle.zip",
      "chmod +x /home/ubuntu/pi-father-spinner/bin/*.sh /home/ubuntu/pi-father-spinner/bin/*.ts",
      "printf '%s\\n' ${jsonencode(local.pi_settings_json)} > /home/ubuntu/.pi/agent/settings.json",
      "printf '%s\\n' ${jsonencode(local.llm_env_content)} > /home/ubuntu/.pi/agent/.env",
      "chmod 600 /home/ubuntu/.pi/agent/.env",
      local.has_local_pi_auth ? "printf '%s\\n' ${jsonencode(file(local.local_pi_auth_path))} > /home/ubuntu/.pi/agent/auth.json && chmod 600 /home/ubuntu/.pi/agent/auth.json" : "true",
      "printf '%s\\n' ${jsonencode(local.bot_pool_json)} > /tmp/pi-bots-pool.json",
      "cd /home/ubuntu/pi-father-spinner && npm test",
      "FATHER_BOT_TOKEN=${jsonencode(var.father_bot_token)} ALLOWED_TELEGRAM_USER_ID=${jsonencode(var.allowed_telegram_user_id)} node --experimental-strip-types /home/ubuntu/pi-father-spinner/bin/sync-pool.ts /tmp/pi-bots-pool.json",
      "rm -f /tmp/pi-bots-pool.json",
      "sudo systemctl daemon-reload",
      "sudo systemctl restart pi-father.service",
      "sleep 2",
      "sudo systemctl status pi-father.service --no-pager"
    ]
  }
}
