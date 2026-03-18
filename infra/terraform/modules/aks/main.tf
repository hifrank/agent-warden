variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "kubernetes_version" { type = string }
variable "system_node_vm_size" { type = string }
variable "tenant_node_vm_size" { type = string }
variable "tenant_node_min_count" { type = number }
variable "tenant_node_max_count" { type = number }
variable "sandbox_node_vm_size" {
  type    = string
  default = "Standard_D4s_v5"
}
variable "sandbox_node_min_count" {
  type    = number
  default = 1
}
variable "sandbox_node_max_count" {
  type    = number
  default = 10
}
variable "vnet_subnet_id" { type = string }
variable "agc_id" {
  type        = string
  description = "Application Gateway for Containers resource ID for ALB Controller association"
}
variable "log_analytics_workspace_id" { type = string }
variable "acr_id" { type = string }
variable "admin_group_object_id" { type = string }
variable "authorized_ip_ranges" {
  type        = list(string)
  description = "CIDR ranges allowed to access the API server (empty = unrestricted)"
  default     = []
}
variable "tags" { type = map(string) }

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = var.name
  kubernetes_version  = var.kubernetes_version

  # Public cluster with authorized IP ranges
  private_cluster_enabled = false

  api_server_access_profile {
    authorized_ip_ranges = var.authorized_ip_ranges
  }

  # Entra ID RBAC
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    admin_group_object_ids = [var.admin_group_object_id]
  }

  # Workload Identity + OIDC issuer
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # System node pool
  default_node_pool {
    name                 = "system"
    vm_size              = var.system_node_vm_size
    node_count           = 3
    vnet_subnet_id       = var.vnet_subnet_id
    os_disk_type         = "Managed"
    os_disk_size_gb      = 128
    zones                = ["1", "3"]
    auto_scaling_enabled = false

    node_labels = {
      "openclaw.io/pool" = "system"
    }

    upgrade_settings {
      max_surge = "33%"
    }
  }

  # Azure CNI networking
  network_profile {
    network_plugin    = "azure"
    network_policy    = "calico"
    service_cidr      = "10.2.0.0/16"
    dns_service_ip    = "10.2.0.10"
    load_balancer_sku = "standard"
  }

  # Identity for cluster operations
  identity {
    type = "SystemAssigned"
  }

  # ALB Controller add-on for Application Gateway for Containers (Gateway API)
  # The ALB Controller reconciles Gateway + HTTPRoute objects into AGC configuration.
  # It deploys into kube-system and uses Workload Identity.
  web_app_routing {
    dns_zone_ids = []
  }

  # Monitoring add-on
  oms_agent {
    log_analytics_workspace_id = var.log_analytics_workspace_id
  }

  # Key Vault + Secrets Store CSI Driver add-on
  key_vault_secrets_provider {
    secret_rotation_enabled  = true
    secret_rotation_interval = "5m"
  }

  # Microsoft Defender for Containers
  microsoft_defender {
    log_analytics_workspace_id = var.log_analytics_workspace_id
  }

  tags = var.tags
}

# Tenant node pool — separate pool for OpenClaw tenant pods
resource "azurerm_kubernetes_cluster_node_pool" "tenant" {
  name                  = "tenant"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.tenant_node_vm_size
  vnet_subnet_id        = var.vnet_subnet_id
  os_disk_type          = "Managed"
  os_disk_size_gb       = 128
  zones                 = ["1", "3"]

  auto_scaling_enabled = true
  min_count            = var.tenant_node_min_count
  max_count            = var.tenant_node_max_count

  node_labels = {
    "openclaw.io/pool" = "tenant"
  }

  node_taints = [
    "openclaw.io/tenant-only=true:NoSchedule"
  ]

  upgrade_settings {
    max_surge = "33%"
  }

  tags = var.tags
}

# Sandbox node pool — Kata Containers (Hyper-V microVM isolation) for tool execution (§4.1.1)
resource "azurerm_kubernetes_cluster_node_pool" "sandbox" {
  name                  = "sandbox"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.sandbox_node_vm_size
  vnet_subnet_id        = var.vnet_subnet_id
  os_disk_type          = "Managed"
  os_disk_size_gb       = 128
  os_sku                = "AzureLinux"  # Required for Kata Containers
  zones                 = ["1", "3"]
  workload_runtime      = "OCIContainer"  # KataMshvVmIsolation not yet supported in azurerm v4.x

  auto_scaling_enabled = true
  min_count            = var.sandbox_node_min_count
  max_count            = var.sandbox_node_max_count

  node_labels = {
    "openclaw.io/pool" = "sandbox"
  }

  node_taints = [
    "openclaw.io/sandbox-only=true:NoSchedule"
  ]

  upgrade_settings {
    max_surge = "33%"
  }

  tags = var.tags
}

# Grant AKS kubelet identity AcrPull on ACR
resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.this.name
}

output "cluster_id" {
  value = azurerm_kubernetes_cluster.this.id
}

output "oidc_issuer_url" {
  value = azurerm_kubernetes_cluster.this.oidc_issuer_url
}

output "kubelet_identity_object_id" {
  value = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}

output "node_resource_group" {
  value = azurerm_kubernetes_cluster.this.node_resource_group
}
