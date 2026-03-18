# Check DLP policy and rule details — diagnose why alerts aren't firing
Import-Module ExchangeOnlineManagement
Connect-IPPSSession

Write-Output "`n=== DLP Policy ==="
$policy = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII"
$policy | Format-List Name, Mode, Workload, Enabled, EnforcementPlane*

Write-Output "`n=== DLP Rule ==="
$rule = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
$rule | Format-List Name, Disabled, ParentPolicyName, ContentContainsSensitiveInformation, RestrictAccess, GenerateAlert, GenerateIncidentReport, IncidentReportContent, ReportSeverityLevel, NotifyUser, NotifySenderType, BlockAccess, BlockAccessScope

Write-Output "`n=== SIT Types in Rule ==="
$rule.ContentContainsSensitiveInformation | Format-Table -AutoSize

Write-Output "`n=== Locations on Policy ==="
$policy | Select-Object -ExpandProperty Locations | Format-List
