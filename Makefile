.PHONY: test infra-init infra-fmt infra-validate infra-plan infra-apply infra-destroy ansible-deploy ssh attach-father status

TERRAFORM_DIR := infra
ANSIBLE_DIR := infra/ansible

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

ansible-deploy:
	node --experimental-strip-types bin/generate-ansible-vars.ts
	cd $(ANSIBLE_DIR) && PATH="$$HOME/.local/bin:$$PATH" ANSIBLE_CONFIG="$$(pwd)/ansible.cfg" ansible-playbook -i inventory.ini playbook.yml

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
