# ─── dogfood: Agent Warden compute in tenant dab94ed2 / sub 528423b5 ───

# Target Azure tenant & subscription
tenant_id       = "dab94ed2-4cee-4b36-b007-6618f570b4a3"
subscription_id = "528423b5-a9b1-413b-a582-27dc93b0fc78"

environment               = "dev"
location                  = "eastus2"
base_name                 = "awarden"
kubernetes_version        = "1.34"
system_node_vm_size              = "Standard_B4s_v2"
system_node_count                = 1
tenant_node_vm_size              = "Standard_D4s_v5"
tenant_node_count                = 1
tenant_node_autoscaling_enabled  = false
tenant_node_min_count            = 1
tenant_node_max_count            = 10
log_retention_days               = 90
aks_authorized_ip_ranges         = []
aks_availability_zones           = []
aks_admin_group_object_id = "18a3e59b-6215-4c1e-bac1-c1518f05ad7b"

tags = {
  environment = "dev"
  project     = "agent-warden"
  cost_center = "engineering"
  tenant      = "dab94ed2"
}

# Purview — cross-tenant (E5 tenant "ecardpoc4ecv")
purview_account_name = "ecardpoc4ecv"

# Tenant Key Vaults (prefixed to avoid global name collision with dev)
tenant_ids = ["df-demo"]
