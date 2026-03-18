# ─────────────────────────────────────────────────────────────────────
# Microsoft Purview — EXTERNAL (cross-tenant)
#
# The Purview account lives in the E5 tenant "ecardpoc4ecv"
#   Tenant ID: 2cf24558-0d31-439b-9c8d-6fdce3931ae7
#
# We do NOT create a Purview account in the platform subscription.
# Auth uses the multi-tenant app registration (d94c93dd) with
# ClientSecretCredential, same as the DLP plugin.
#
# The app registration needs these Purview-internal roles in the
# E5 tenant's Purview account (granted via Purview governance portal):
#   - Data Curator   (push entities, create types, write lineage)
#   - Data Reader    (read catalog, browse lineage)
#   - Data Source Administrator (register custom data sources)
#
# Purview Data Map API scope: https://purview.azure.net/.default
# DLP processContent API scope: https://graph.microsoft.com/.default
# ─────────────────────────────────────────────────────────────────────

# Purview endpoints are configured as variables since the account
# is managed externally in the E5 tenant.
#
# Set these in terraform.tfvars or via TF_VAR_ env vars:
#   purview_account_name = "your-purview-account-name"
#
# Then the outputs below will produce the correct endpoint URLs.

data "azurerm_client_config" "current" {}

# Grant Purview MSI Cosmos DB Account Reader (scan Cosmos DB tenant registry)
# Note: This requires the Purview MSI principal ID from the E5 tenant
# to be provided as a variable. Skip if not available.
resource "azurerm_role_assignment" "purview_cosmos_reader" {
  count                = var.purview_identity_principal_id != "" && var.cosmos_account_id != "" ? 1 : 0
  scope                = var.cosmos_account_id
  role_definition_name = "Cosmos DB Account Reader Role"
  principal_id         = var.purview_identity_principal_id
}
