# Update "Agent Warden - Block PII" DLP policy rule to fire alerts on match
#
# Prerequisites: ExchangeOnlineManagement module, admin sign-in to Purview tenant (2cf24558)
#
# Usage: pwsh test/update-dlp-alert.ps1

Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Security & Compliance PowerShell..."
Write-Output "Sign in as admin of the Purview tenant (2cf24558-0d31-439b-9c8d-6fdce3931ae7)."
Connect-IPPSSession
Write-Output "Connected!"

Write-Output ""
Write-Output "=== Current Rule State ==="
$rule = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
$rule | Format-List Name, GenerateAlert, GenerateIncidentReport, IncidentReportContent, NotifyUser, ReportSeverityLevel

Write-Output ""
Write-Output "=== Updating rule to fire alerts on match ==="

$adminEmail = "admin@ecardpoc.onmicrosoft.com"

Set-DlpComplianceRule -Identity "Block SSN and Credit Card" `
    -GenerateAlert @($adminEmail) `
    -GenerateIncidentReport @($adminEmail) `
    -IncidentReportContent @("Title","MatchedItem","RulesMatched","Severity","SensitivityLabel") `
    -ReportSeverityLevel "High"

Write-Output ""
Write-Output "=== Updated Rule State ==="
$updatedRule = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
$updatedRule | Format-List Name, GenerateAlert, GenerateIncidentReport, IncidentReportContent, ReportSeverityLevel

Write-Output ""
Write-Output "Done! The rule will now fire alerts in Purview Alerts dashboard when PII is detected."
Write-Output "Verify at: https://purview.microsoft.com/datalossprevention/alerts"
