output "aks_cluster_name" {
  description = "AKS cluster name"
  value       = module.aks.cluster_name
}

output "aks_oidc_issuer_url" {
  description = "AKS OIDC issuer URL for Workload Identity federation"
  value       = module.aks.oidc_issuer_url
}

output "acr_login_server" {
  description = "ACR login server"
  value       = module.acr.login_server
}

output "cosmos_endpoint" {
  description = "Cosmos DB account endpoint"
  value       = module.cosmos.endpoint
}

output "keyvault_uri" {
  description = "Platform Key Vault URI"
  value       = module.keyvault.vault_uri
}

output "tenant_keyvault_uris" {
  description = "Per-tenant Key Vault URIs"
  value       = { for k, v in module.tenant_keyvault : k => v.vault_uri }
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace resource ID"
  value       = module.log_analytics.workspace_id
}

output "platform_identity_client_id" {
  description = "Platform managed identity client ID"
  value       = module.platform_identity.client_id
}

output "platform_identity_principal_id" {
  description = "Platform managed identity principal ID"
  value       = module.platform_identity.principal_id
}

output "appinsights_connection_string" {
  description = "Application Insights connection string"
  value       = module.appinsights.connection_string
  sensitive   = true
}

output "purview_catalog_endpoint" {
  description = "Microsoft Purview catalog / Data Map endpoint (E5 tenant ecardpoc4ecv)"
  value       = module.purview.catalog_endpoint
}

output "purview_scan_endpoint" {
  description = "Microsoft Purview scan endpoint (E5 tenant ecardpoc4ecv)"
  value       = module.purview.scan_endpoint
}

output "purview_governance_endpoint" {
  description = "Microsoft Purview governance / Data Map API endpoint (E5 tenant ecardpoc4ecv)"
  value       = module.purview.governance_endpoint
}

output "purview_tenant_id" {
  description = "Purview E5 tenant ID"
  value       = module.purview.tenant_id
}
