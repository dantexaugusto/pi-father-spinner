.PHONY: test infra-init infra-fmt infra-validate infra-plan infra-apply infra-destroy ssh attach-father status

TERRAFORM_DIR := infra

test:
	npm test

infra-init:
	terraform -chdir=$(TERRAFORM_DIR) init

infra-fmt:
	terraform -chdir=$(TERRAFORM_DIR) fmt -recursive

infra-validate:
	terraform -chdir=$(TERRAFORM_DIR) validate

infra-plan:
	terraform -chdir=$(TERRAFORM_DIR) plan

infra-apply:
	terraform -chdir=$(TERRAFORM_DIR) apply

infra-destroy:
	terraform -chdir=$(TERRAFORM_DIR) destroy

ssh:
	@eval "$$(terraform -chdir=$(TERRAFORM_DIR) output -raw ssh_command)"

attach-father:
	@eval "$$(terraform -chdir=$(TERRAFORM_DIR) output -raw attach_father_tmux_command)"

status:
	@IP=$$(terraform -chdir=$(TERRAFORM_DIR) output -raw static_public_ip) && \
	KEY=$$(terraform -chdir=$(TERRAFORM_DIR) output -raw ssh_private_key_path) && \
	ssh -i "$$KEY" "ubuntu@$$IP" "sudo systemctl status pi-father.service --no-pager && echo '--- TMUX SESSIONS ---' && tmux list-sessions"
