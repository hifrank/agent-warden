locals {
  suffix    = "${var.base_name}-${var.environment}"
  suffix_nohyphen = replace(local.suffix, "-", "")

  common_tags = merge(var.tags, {
    environment = var.environment
    project     = "agent-warden"
    managed_by  = "terraform"
  })
}

data "azurerm_resource_group" "main" {
  name = "rg-${local.suffix}"
}

# ─── Log Analytics ────────────────────────────────────────
module "log_analytics" {
  source = "./modules/log-analytics"

  name                = "log-${local.suffix}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.main.name
  retention_days      = var.log_retention_days
  tags                = local.common_tags
}

# ─── Virtual Network ──────────────────────────────────────
module "vnet" {
  source = "./modules/vnet"

  name                = "vnet-${local.suffix}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.main.name
  tags                = local.common_tags
}

# ─── Azure Container Registry ─────────────────────────────
module "acr" {
  source = "./modules/acr"

  name                       = "acr${local.suffix_nohyphen}"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = module.log_analytics.workspace_id
  tags                       = local.common_tags
}

# ─── AKS Cluster ──────────────────────────────────────────
module "aks" {
  source = "./modules/aks"

  name                       = "aks-${local.suffix}"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.main.name
  kubernetes_version         = var.kubernetes_version
  system_node_vm_size        = var.system_node_vm_size
  tenant_node_vm_size        = var.tenant_node_vm_size
  tenant_node_min_count      = var.tenant_node_min_count
  tenant_node_max_count      = var.tenant_node_max_count
  vnet_subnet_id             = module.vnet.aks_subnet_id
  agc_id                     = module.appgw.agc_id
  log_analytics_workspace_id = module.log_analytics.workspace_id
  acr_id                     = module.acr.acr_id
  admin_group_object_id      = var.aks_admin_group_object_id
  authorized_ip_ranges       = var.aks_authorized_ip_ranges
  tags                       = local.common_tags
}

# ─── Platform Key Vault ───────────────────────────────────
module "keyvault" {
  source = "./modules/keyvault"

  name                            = "kv-plat-${local.suffix}"
  location                        = var.location
  resource_group_name             = data.azurerm_resource_group.main.name
  log_analytics_workspace_id      = module.log_analytics.workspace_id
  aks_kubelet_identity_object_id  = module.aks.kubelet_identity_object_id
  tags                            = local.common_tags
}

# ─── Cosmos DB ─────────────────────────────────────────────
module "cosmos" {
  source = "./modules/cosmos"

  name                       = "cosmos-${local.suffix}"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = module.log_analytics.workspace_id
  tags                       = local.common_tags
}

# ─── Application Gateway for Containers (AGC) ────────
module "appgw" {
  source = "./modules/appgw"

  name                       = "agc-${local.suffix}"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.main.name
  subnet_id                  = module.vnet.appgw_subnet_id
  log_analytics_workspace_id = module.log_analytics.workspace_id
  tags                       = local.common_tags
}

# ─── Application Insights ──────────────────────────────────
module "appinsights" {
  source = "./modules/appinsights"

  name                       = "appi-${local.suffix}"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = module.log_analytics.workspace_id
  tags                       = local.common_tags
}

# ─── Platform Managed Identity ─────────────────────────────
module "platform_identity" {
  source = "./modules/managed-identity"

  name                = "mi-platform-${local.suffix}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.main.name
  tags                = local.common_tags
}

# ─── Microsoft Purview (External — E5 tenant ecardpoc4ecv) ──────────
module "purview" {
  source = "./modules/purview"

  purview_account_name          = var.purview_account_name
  purview_tenant_id             = var.purview_tenant_id
  purview_identity_principal_id = var.purview_identity_principal_id
  cosmos_account_id             = module.cosmos.account_id
  tags                          = local.common_tags
}
