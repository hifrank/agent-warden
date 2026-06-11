output "cosmos_endpoint" {
  description = "Cosmos DB endpoint for portal"
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "cosmos_database" {
  description = "Cosmos DB database name"
  value       = azurerm_cosmosdb_sql_database.warden.name
}

output "appinsights_app_id" {
  description = "Application Insights App ID for query API"
  value       = azurerm_application_insights.this.app_id
}

output "appinsights_connection_string" {
  description = "Application Insights connection string for OTel export"
  value       = azurerm_application_insights.this.connection_string
  sensitive   = true
}
