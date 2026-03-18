output "account_name" {
  description = "Purview account name (in E5 tenant ecardpoc4ecv)"
  value       = var.purview_account_name
}

output "tenant_id" {
  description = "Purview tenant ID (E5 tenant)"
  value       = var.purview_tenant_id
}

output "catalog_endpoint" {
  description = "Purview catalog / Data Map endpoint"
  value       = "https://${var.purview_account_name}.purview.azure.com"
}

output "scan_endpoint" {
  description = "Purview scan endpoint"
  value       = "https://${var.purview_account_name}.scan.purview.azure.com"
}

output "governance_endpoint" {
  description = "Purview governance / Data Map API endpoint (Atlas v2)"
  value       = "https://${var.purview_account_name}.purview.azure.com"
}
