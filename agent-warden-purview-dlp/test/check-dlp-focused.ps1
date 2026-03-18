# Focused check: policy distribution status + alert config
Import-Module ExchangeOnlineManagement
Connect-IPPSSession

Write-Output "=== Policy Distribution ==="
$p = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -DistributionDetail
Write-Output "Status: $($p.DistributionStatus)"
Write-Output "LastModified: $($p.DistributionLastModifiedDate)"
if ($p.DistributionDetail) {
    $p.DistributionDetail | Format-List
}

Write-Output "`n=== Rule RestrictAccess ==="
$r = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
Write-Output ($r.RestrictAccess | ConvertTo-Json -Depth 5 -Compress)

Write-Output "`n=== Rule SIT Details ==="
foreach ($sit in $r.ContentContainsSensitiveInformation) {
    Write-Output "  SIT: $($sit['name'])  mincount=$($sit['mincount'])  minconfidence=$($sit['minconfidence'])  confidencelevel=$($sit['confidencelevel'])"
}

Write-Output "`n=== Alert Config ==="
Write-Output "GenerateAlert: $($r.GenerateAlert)"
Write-Output "GenerateIncidentReport: $($r.GenerateIncidentReport)"
Write-Output "ReportSeverityLevel: $($r.ReportSeverityLevel)"
Write-Output "NotifyUser: $($r.NotifyUser)"
Write-Output "NotifySenderType: $($r.NotifySenderType)"
