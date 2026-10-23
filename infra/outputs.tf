output "lightsail_instance_name" {
  description = "Name of the provisioned AWS Lightsail instance"
  value       = aws_lightsail_instance.pi_vm.name
}

output "static_public_ip" {
  description = "Static public IPv4 address of the Pi-Father VM"
  value       = aws_lightsail_static_ip.pi_ip.ip_address
}

output "ssh_private_key_path" {
  description = "Path to the SSH private key used to connect to the VM"
  value       = local.ssh_private_key_file
}

output "ssh_command" {
  description = "Command to SSH into the Pi-Father VM"
  value       = "ssh -i ${local.ssh_private_key_file} ubuntu@${aws_lightsail_static_ip.pi_ip.ip_address}"
}

output "attach_father_tmux_command" {
  description = "Command to SSH and attach directly to the live Pi-Father tmux session"
  value       = "ssh -t -i ${local.ssh_private_key_file} ubuntu@${aws_lightsail_static_ip.pi_ip.ip_address} 'tmux attach -t pi-father'"
}
