Import-Module ExchangeOnlineManagement

Write-Output "Connecting to S&C PowerShell..."
Write-Output "A browser window will open — sign in as admin of the Purview tenant (2cf24558)."
Connect-IPPSSession
Write-Output "Connected!"

$myEntraAppId = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
$myEntraAppName = "Agent Warden Purview DLP"

Write-Output "Creating DLP policy for Entra app: $myEntraAppName ($myEntraAppId)..."

$locations = '[{"Workload":"Applications","Location":"' + $myEntraAppId + '","LocationDisplayName":"' + $myEntraAppName + '","LocationSource":"Entra","LocationType":"Individual","Inclusions":[{"Type":"Tenant","Identity":"All"}]}]'

New-DlpCompliancePolicy -Name "Agent Warden - Block PII" -Mode Enable -Locations $locations -EnforcementPlanes @("Entra")

Write-Output "Policy created. Adding rule..."

New-DlpComplianceRule -Name "Block SSN and Credit Card" `
    -Policy "Agent Warden - Block PII" `
    -ContentContainsSensitiveInformation @(@{Name="credit card number"},@{Name="U.S. Social Security Number (SSN)"}) `
    -RestrictAccess @(@{setting="UploadText";value="Block"})

Write-Output "Done! DLP policy and rule created."
Write-Output ""
Write-Output "=== Policy ==="
Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" | Format-List Name,Mode,Workload
Write-Output "=== Rule ==="
Get-DlpComplianceRule -Identity "Block SSN and Credit Card" | Format-List Name,ContentContainsSensitiveInformation,RestrictAccess
