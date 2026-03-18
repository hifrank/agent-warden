environment               = "dev"
location                  = "eastus2"
base_name                 = "agentwarden"
kubernetes_version        = "1.32"
system_node_vm_size       = "Standard_D4s_v5"
tenant_node_vm_size       = "Standard_D8s_v5"
tenant_node_min_count     = 2
tenant_node_max_count     = 10
log_retention_days        = 90
aks_authorized_ip_ranges  = ["118.160.24.57/32"]
aks_admin_group_object_id = "" # Set via TF_VAR_aks_admin_group_object_id or override here

tags = {
  environment = "dev"
  project     = "sentinel-mcp"
  cost_center = "engineering"
}

# Purview — external E5 tenant "ecardpoc4ecv"
purview_account_name = "ecardpoc4ecv"
