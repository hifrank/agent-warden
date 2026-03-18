variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "tags" { type = map(string) }

resource "azurerm_cosmosdb_account" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  offer_type          = "Standard"

  # Security
  is_virtual_network_filter_enabled = true
  public_network_access_enabled     = false
  local_authentication_disabled     = true # Force Entra ID auth only

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = false  # Zone-redundant unavailable in eastus2 during high demand
  }

  capabilities {
    name = "EnableServerless"
  }

  tags = var.tags
}

# Database: agent-warden
resource "azurerm_cosmosdb_sql_database" "warden" {
  name                = "agent-warden"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
}

# Container: tenants (tenant registry)
resource "azurerm_cosmosdb_sql_container" "tenants" {
  name                = "tenants"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }
  }
}

# Container: instances (instance registry — §21.2)
resource "azurerm_cosmosdb_sql_container" "instances" {
  name                = "instances"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }
  }
}

# Container: skills (platform skill allowlist — §17)
resource "azurerm_cosmosdb_sql_container" "skills" {
  name                = "skills"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/skillId"]
}

# Container: audit (activity tracing — §19)
resource "azurerm_cosmosdb_sql_container" "audit" {
  name                = "audit"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]

  default_ttl = 7776000 # 90 days — older records archived to blob
}

# Container: governance (data governance activity ledger + lineage — §11)
resource "azurerm_cosmosdb_sql_container" "governance" {
  name                = "governance"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.warden.name
  partition_key_paths = ["/tenantId"]

  default_ttl = 7776000 # 90 days default — configurable per tier (30d free, 90d pro, 365d enterprise)

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    composite_index {
      index {
        path  = "/tenantId"
        order = "ascending"
      }
      index {
        path  = "/type"
        order = "ascending"
      }
      index {
        path  = "/timestamp"
        order = "descending"
      }
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "cosmos" {
  name                       = "cosmos-diagnostics"
  target_resource_id         = azurerm_cosmosdb_account.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "DataPlaneRequests"
  }

  enabled_log {
    category = "QueryRuntimeStatistics"
  }

  metric {
    category = "AllMetrics"
  }
}

output "account_id" {
  value = azurerm_cosmosdb_account.this.id
}

output "endpoint" {
  value = azurerm_cosmosdb_account.this.endpoint
}

output "database_name" {
  value = azurerm_cosmosdb_sql_database.warden.name
}
