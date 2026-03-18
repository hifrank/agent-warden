variable "purview_account_name" {
  description = "Purview account name in the E5 tenant (ecardpoc4ecv)"
  type        = string
}

variable "purview_tenant_id" {
  description = "E5 tenant ID where Purview lives"
  type        = string
  default     = "2cf24558-0d31-439b-9c8d-6fdce3931ae7"
}

variable "purview_identity_principal_id" {
  description = "Purview system-assigned MI principal ID from the E5 tenant (for Cosmos RBAC). Empty to skip."
  type        = string
  default     = ""
}

variable "cosmos_account_id" {
  description = "Cosmos DB account resource ID for Purview scan access (optional)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply"
  type        = map(string)
  default     = {}
}
