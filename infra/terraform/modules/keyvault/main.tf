variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "aks_kubelet_identity_object_id" { type = string }
variable "tags" { type = map(string) }

# Private endpoint variables
variable "private_endpoints_subnet_id" {
  type        = string
  description = "Subnet ID for private endpoints"
}
variable "keyvault_private_dns_zone_id" {
  type        = string
  description = "Private DNS Zone ID for privatelink.vaultcore.azure.net"
}

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "premium" # HSM-backed — FIPS 140-2 Level 3

  # Security hardening
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  enable_rbac_authorization  = true

  # Network restrictions — deny public, allow only private endpoints
  public_network_access_enabled = false
  network_acls {
    bypass         = "AzureServices"
    default_action = "Deny"
  }

  tags = var.tags
}

# Private Endpoint for Key Vault
resource "azurerm_private_endpoint" "keyvault" {
  name                = "pe-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoints_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "psc-${var.name}"
    private_connection_resource_id = azurerm_key_vault.this.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.keyvault_private_dns_zone_id]
  }
}

# Grant AKS kubelet identity Key Vault Secrets User
resource "azurerm_role_assignment" "aks_kv_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = var.aks_kubelet_identity_object_id
}

resource "azurerm_monitor_diagnostic_setting" "kv" {
  name                       = "kv-diagnostics"
  target_resource_id         = azurerm_key_vault.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "AuditEvent"
  }

  metric {
    category = "AllMetrics"
  }
}

output "vault_id" {
  value = azurerm_key_vault.this.id
}

output "vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "vault_name" {
  value = azurerm_key_vault.this.name
}
