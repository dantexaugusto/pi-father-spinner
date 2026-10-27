variable "aws_region" {
  description = "AWS region where the Lightsail instance will be provisioned"
  type        = string
  default     = "us-east-1"
}

variable "availability_zone" {
  description = "AWS Availability Zone for the Lightsail instance (e.g. us-east-1a)"
  type        = string
  default     = "us-east-1a"
}

variable "project_name" {
  description = "Base name for Lightsail resources"
  type        = string
  default     = "pi-father-spinner"
}

variable "blueprint_id" {
  description = "Lightsail OS Blueprint ID (Ubuntu 24.04 LTS recommended)"
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Lightsail plan/bundle ID (e.g. small_3_0 = 2GB RAM, medium_3_0 = 4GB RAM, large_3_0 = 8GB RAM)"
  type        = string
  default     = "medium_3_0"
}

variable "ssh_allowed_cidrs" {
  description = "List of CIDR blocks allowed to connect via SSH (port 22)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_public_key_path" {
  description = "Optional path to an existing local SSH public key (e.g. ~/.ssh/id_ed25519.pub). If empty, Terraform generates a dedicated key pair in infra/keys/."
  type        = string
  default     = ""
}

variable "ssh_private_key_path" {
  description = "Optional path to the matching SSH private key (e.g. ~/.ssh/id_ed25519). Required if ssh_public_key_path is set."
  type        = string
  default     = ""
}

variable "pi_version" {
  description = "Version of @earendil-works/pi-coding-agent to install globally on the VM"
  type        = string
  default     = "0.80.2"
}

variable "default_provider" {
  description = "Default LLM provider for Pi settings.json on the VM"
  type        = string
  default     = "amazon-bedrock"
}

variable "default_model" {
  description = "Default LLM model for Pi settings.json on the VM"
  type        = string
  default     = "deepseek.v3.2"
}

variable "default_thinking_level" {
  description = "Default thinking level for Pi settings.json on the VM"
  type        = string
  default     = "high"
}

variable "father_bot_token" {
  description = "Telegram Bot Token (from @BotFather) for the master Pi-Father agent"
  type        = string
  default     = ""
  sensitive   = true
}

variable "allowed_telegram_user_id" {
  description = "Your numeric Telegram User ID to pre-authorize on Pi-Father and all child bots"
  type        = string
  default     = ""
}

variable "bot_pool" {
  description = "List of pre-created Telegram Bot tokens for child Pi agents"
  type = list(object({
    token        = string
    default_name = optional(string)
  }))
  default   = []
  sensitive = true
}

variable "llm_env_vars" {
  description = "Map of environment variables (API keys like GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY) written to ~/.pi/agent/.env on the VM"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "sync_local_pi_auth" {
  description = "If true and ~/.pi/agent/auth.json exists locally, copies it to the VM so OAuth/subscription credentials work out-of-the-box"
  type        = bool
  default     = true
}
