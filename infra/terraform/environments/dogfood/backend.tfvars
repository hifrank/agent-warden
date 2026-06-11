# Backend state for dogfood (tenant dab94ed2 / sub 528423b5)
# The storage account must be created first — see bootstrap-dogfood.sh
resource_group_name  = "tfstate-agentwarden"
storage_account_name = "stawardendogfoodtfst"
container_name       = "tfstate"
key                  = "agent-warden-dogfood.tfstate"
use_azuread_auth     = true
subscription_id      = "528423b5-a9b1-413b-a582-27dc93b0fc78"
tenant_id            = "dab94ed2-4cee-4b36-b007-6618f570b4a3"
