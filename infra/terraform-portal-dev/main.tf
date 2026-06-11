terraform {
  required_version = ">= 1.7"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

locals {
  tags = {
    environment = "dev"
    project     = "agent-warden-portal"
    managed_by  = "terraform"
  }
}

data "azurerm_resource_group" "main" {
  name = "rg-agentwarden-dev"
}

data "azurerm_client_config" "current" {}

# ─── Log Analytics (required by App Insights) ─────────────
resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-portal-agentwarden-dev"
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# ─── Application Insights ─────────────────────────────────
resource "azurerm_application_insights" "this" {
  name                = "appi-portal-agentwarden-dev"
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = "other"
  tags                = local.tags
}

# ─── Cosmos DB (serverless, PUBLIC access for local dev) ───
resource "azurerm_cosmosdb_account" "this" {
  name                = "cosmos-portal-agentwarden-dev"
  location            = data.azurerm_resource_group.main.location
  resource_group_name = data.azurerm_resource_group.main.name
  offer_type          = "Standard"

  public_network_access_enabled     = true    # Allow local dev access
  local_authentication_disabled     = true    # Entra ID auth only
  is_virtual_network_filter_enabled = false

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = data.azurerm_resource_group.main.location
    failover_priority = 0
  }

  capabilities {
    name = "EnableServerless"
  }

  tags = local.tags
}

# ─── RBAC: Grant current user Cosmos DB data access ───────
resource "azurerm_cosmosdb_sql_role_assignment" "current_user" {
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
  # Built-in "Cosmos DB Built-in Data Contributor" role
  role_definition_id  = "${azurerm_cosmosdb_account.this.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = data.azurerm_client_config.current.object_id
  scope               = azurerm_cosmosdb_account.this.id
}

# ─── Database: agent-warden ───────────────────────────────
resource "azurerm_cosmosdb_sql_database" "warden" {
  name                = "agent-warden"
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
}

# ─── Container: instances ─────────────────────────────────
resource "azurerm_cosmosdb_sql_container" "instances" {
  name                = "instances"
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]
}

# ─── Container: tenants ───────────────────────────────────
resource "azurerm_cosmosdb_sql_container" "tenants" {
  name                = "tenants"
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]
}

# ─── Container: skills ────────────────────────────────────
resource "azurerm_cosmosdb_sql_container" "skills" {
  name                = "skills"
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/skillId"]
}

# ─── Container: audit ─────────────────────────────────────
resource "azurerm_cosmosdb_sql_container" "audit" {
  name                = "audit"
  resource_group_name = data.azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]
  default_ttl         = 7776000
}
