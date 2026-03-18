variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "subnet_id" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "tags" { type = map(string) }

# ─── Application Gateway for Containers (AGC) ─────────────
# AGC is the next-gen L7 load balancer that uses Gateway API natively.
# The ALB Controller in AKS reconciles Gateway/HTTPRoute objects into AGC config.

resource "azurerm_application_load_balancer" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_application_load_balancer_subnet_association" "this" {
  name                         = "agc-subnet-assoc"
  application_load_balancer_id = azurerm_application_load_balancer.this.id
  subnet_id                    = var.subnet_id
}

resource "azurerm_application_load_balancer_frontend" "this" {
  name                         = "${var.name}-frontend"
  application_load_balancer_id = azurerm_application_load_balancer.this.id
}

# ─── WAF Policy for AGC ───────────────────────────────────
resource "azurerm_web_application_firewall_policy" "this" {
  name                = "waf-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name

  policy_settings {
    enabled                     = true
    mode                        = "Prevention"
    request_body_check          = true
    file_upload_limit_in_mb     = 10
    max_request_body_size_in_kb = 128
  }

  managed_rules {
    managed_rule_set {
      type    = "OWASP"
      version = "3.2"
    }

    managed_rule_set {
      type    = "Microsoft_BotManagerRuleSet"
      version = "1.0"
    }
  }

  tags = var.tags
}

# ─── Diagnostics ──────────────────────────────────────────
resource "azurerm_monitor_diagnostic_setting" "agc" {
  name                       = "agc-diagnostics"
  target_resource_id         = azurerm_application_load_balancer.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "TrafficControllerAccessLog"
  }

  metric {
    category = "AllMetrics"
  }
}

output "agc_id" {
  value = azurerm_application_load_balancer.this.id
}

output "frontend_id" {
  value = azurerm_application_load_balancer_frontend.this.id
}

output "frontend_fqdn" {
  value = azurerm_application_load_balancer_frontend.this.fully_qualified_domain_name
}

output "waf_policy_id" {
  value = azurerm_web_application_firewall_policy.this.id
}
