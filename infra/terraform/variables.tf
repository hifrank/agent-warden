variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus2"
}

variable "base_name" {
  description = "Base name prefix for all resources (3-12 chars)"
  type        = string
  default     = "agentwarden"
  validation {
    condition     = length(var.base_name) >= 3 && length(var.base_name) <= 12
    error_message = "base_name must be 3-12 characters."
  }
}

variable "kubernetes_version" {
  description = "AKS Kubernetes version"
  type        = string
  default     = "1.30"
}

variable "system_node_vm_size" {
  description = "VM size for AKS system node pool"
  type        = string
  default     = "Standard_D4s_v5"
}

variable "tenant_node_vm_size" {
  description = "VM size for AKS tenant node pool"
  type        = string
  default     = "Standard_D8s_v5"
}

variable "tenant_node_min_count" {
  description = "Minimum node count for tenant node pool"
  type        = number
  default     = 2
}

variable "tenant_node_max_count" {
  description = "Maximum node count for tenant node pool"
  type        = number
  default     = 20
}

variable "aks_authorized_ip_ranges" {
  description = "CIDR ranges allowed to access the AKS API server"
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Log Analytics workspace retention in days"
  type        = number
  default     = 180
}

variable "aks_admin_group_object_id" {
  description = "Entra ID group Object ID for AKS cluster admin RBAC"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# ─── Tenant Configuration ──────────────────────────────────
variable "tenant_ids" {
  description = "Set of tenant IDs to create Key Vaults for (e.g., {\"demo-tenant\", \"acme-corp\"})"
  type        = set(string)
  default     = []
}

# ─── Purview (external — E5 tenant) ────────────────────────
variable "purview_account_name" {
  description = "Purview account name in the E5 tenant (ecardpoc4ecv)"
  type        = string
}

variable "purview_tenant_id" {
  description = "E5 tenant ID where Purview account lives"
  type        = string
  default     = "2cf24558-0d31-439b-9c8d-6fdce3931ae7"
}

variable "purview_identity_principal_id" {
  description = "Purview MSI principal ID from E5 tenant (for Cosmos RBAC). Empty to skip."
  type        = string
  default     = ""
}
