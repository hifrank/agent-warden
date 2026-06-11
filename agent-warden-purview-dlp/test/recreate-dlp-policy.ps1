# Recreate the DLP policy with Applications workload via Locations parameter
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to S&C PowerShell..."
Connect-IPPSSession
Write-Output "Connected!"

# Check if policy exists and delete
$existing = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Write-Output "Deleting existing policy..."
    Remove-DlpComplianceRule -Identity "Block SSN and Credit Card" -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep 2
    Remove-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -Confirm:$false
    Start-Sleep 15
    
    $check = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -ErrorAction SilentlyContinue
    if ($null -ne $check) {
        Write-Output "WARNING: Policy still in PendingDeletion, waiting..."
        Start-Sleep 30
    }
}

# Create with Locations JSON
$locJson = '[{"Workload":"Applications","Location":"d94c93dd-3c80-4f3d-9671-8b71a7dccafa","LocationDisplayName":"Agent Warden Purview DLP","LocationSource":"Entra","LocationType":"Individual","Inclusions":[{"Type":"Tenant","Identity":"All","DisplayName":"All","Name":"All"}]}]'

Write-Output ""
Write-Output "Creating policy with Applications location..."
New-DlpCompliancePolicy -Name "Agent Warden - Block PII" `
    -Mode Enable `
    -Locations $locJson

Start-Sleep 5

$p = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII"
Write-Output "Workload: $($p.Workload)"
Write-Output "Locations: $($p.Locations)"

if ($p.Workload -notmatch "Applications") {
    Write-Output ""
    Write-Output "Applications workload not set — trying with Exchange + Locations..."
    Set-DlpCompliancePolicy -Identity "Agent Warden - Block PII" `
        -AddExchangeLocation All `
        -AddSharePointLocation All `
        -AddOneDriveLocation All
    Start-Sleep 3
}

Write-Output ""
Write-Output "Creating rule..."
New-DlpComplianceRule -Name "Block SSN and Credit Card" `
    -Policy "Agent Warden - Block PII" `
    -ContentContainsSensitiveInformation @(@{Name="Credit Card Number"},@{Name="U.S. Social Security Number (SSN)"}) `
    -RestrictAccess @(@{setting="UploadText";value="Block"}) `
    -BlockAccess $true `
    -BlockAccessScope All `
    -Confirm:$false

Start-Sleep 3

$r = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
Write-Output "BlockAccess: $($r.BlockAccess)"

$p2 = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII"
Write-Output ""
Write-Output "=== Final State ==="
Write-Output "Workload: $($p2.Workload)"
Write-Output "Locations: $($p2.Locations)"
Write-Output "DistributionStatus: $($p2.DistributionStatus)"
