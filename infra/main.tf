locals {
  use_custom_ssh_key    = trimspace(var.ssh_public_key_path) != ""
  local_pi_auth_path    = pathexpand("~/.pi/agent/auth.json")
  has_local_pi_auth     = var.sync_local_pi_auth && fileexists(local.local_pi_auth_path)
  local_git_id_rsa_path = pathexpand("~/.ssh/id_rsa")
  local_git_id_pub_path = pathexpand("~/.ssh/id_rsa.pub")
  has_local_git_ssh_key = var.sync_local_git_ssh_key && fileexists(local.local_git_id_rsa_path) && fileexists(local.local_git_id_pub_path)

  ssh_public_key_content  = local.use_custom_ssh_key ? trimspace(file(pathexpand(var.ssh_public_key_path))) : trimspace(tls_private_key.generated[0].public_key_openssh)
  ssh_private_key_content = local.use_custom_ssh_key ? file(pathexpand(var.ssh_private_key_path)) : tls_private_key.generated[0].private_key_openssh
  ssh_private_key_file    = local.use_custom_ssh_key ? pathexpand(var.ssh_private_key_path) : abspath(local_sensitive_file.ssh_private_key[0].filename)

  pi_settings_obj = {
    defaultProvider      = var.default_provider
    defaultModel         = var.default_model
    defaultThinkingLevel = var.default_thinking_level
    theme                = "light"
    hideThinkingBlock    = true
  }

  pi_models_obj = {
    providers = {
      "amazon-bedrock" = {
        baseUrl = "https://bedrock-runtime.${var.aws_region}.amazonaws.com"
        api     = "bedrock-converse-stream"
        models = [
          {
            id            = "us.moonshotai.kimi-k3"
            name          = "US Moonshot AI Kimi K3"
            reasoning     = true
            input         = ["text", "image"]
            contextWindow = 262144
            maxTokens     = 32768
            cost          = { input = 3, output = 15, cacheRead = 0.3, cacheWrite = 0 }
          },
          {
            id            = "global.moonshotai.kimi-k3"
            name          = "Global Moonshot AI Kimi K3"
            reasoning     = true
            input         = ["text", "image"]
            contextWindow = 262144
            maxTokens     = 32768
            cost          = { input = 3, output = 15, cacheRead = 0.3, cacheWrite = 0 }
          }
        ]
      }
    }
  }

  bot_pool_obj = {
    bots = [
      for b in var.bot_pool : {
        token       = b.token
        defaultName = b.default_name
      }
    ]
  }

  merged_env_vars = merge(
    var.llm_env_vars,
    trimspace(var.tavily_api_key) != "" ? { TAVILY_API_KEY = trimspace(var.tavily_api_key) } : {}
  )

  llm_env_content = "${join("\n", [
    for k, v in local.merged_env_vars : "${k}=${jsonencode(v)}"
  ])}\n"

  ansible_group_vars_yaml = yamlencode({
    pi_version               = var.pi_version
    git_user_name            = var.git_user_name
    git_user_email           = var.git_user_email
    father_bot_token         = var.father_bot_token
    allowed_telegram_user_id = var.allowed_telegram_user_id
    pi_settings_json         = local.pi_settings_obj
    pi_models_json           = local.pi_models_obj
    bot_pool_json            = local.bot_pool_obj
    llm_env_content          = local.llm_env_content
    local_git_id_rsa_content = local.has_local_git_ssh_key ? file(local.local_git_id_rsa_path) : ""
    local_git_id_pub_content = local.has_local_git_ssh_key ? file(local.local_git_id_pub_path) : ""
  })
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

# ─── 3. Generate Ansible Inventory & Variables ───────────────────────────────
resource "local_sensitive_file" "ansible_inventory" {
  file_permission = "0600"
  filename        = "${path.module}/ansible/inventory.ini"
  content         = <<-EOT
    [pi_father]
    ${aws_lightsail_static_ip.pi_ip.ip_address} ansible_user=ubuntu ansible_ssh_private_key_file=${local.ssh_private_key_file}
  EOT
}

resource "local_sensitive_file" "ansible_group_vars" {
  file_permission = "0600"
  filename        = "${path.module}/ansible/group_vars/all.yml"
  content         = local.ansible_group_vars_yaml
}

# ─── 4. Run Ansible Playbook to Configure VM & Clone from GitHub ─────────────
resource "terraform_data" "app_deploy" {
  depends_on = [
    aws_lightsail_static_ip_attachment.pi_ip_attach,
    aws_lightsail_instance_public_ports.pi_firewall,
    local_sensitive_file.ansible_inventory,
    local_sensitive_file.ansible_group_vars
  ]

  triggers_replace = [
    aws_lightsail_instance.pi_vm.id,
    aws_lightsail_static_ip.pi_ip.ip_address,
    sha256(local.ansible_group_vars_yaml),
    filesha256("${path.module}/ansible/playbook.yml")
  ]

  provisioner "local-exec" {
    working_dir = "${path.module}/ansible"
    environment = {
      PATH           = "${pathexpand("~/.local/bin")}:/usr/local/bin:/usr/bin:/bin"
      ANSIBLE_CONFIG = "${abspath(path.module)}/ansible/ansible.cfg"
    }
    command = "ansible-playbook -i inventory.ini playbook.yml"
  }
}
