<#
.SYNOPSIS
    Creates the Applications-workload DLP policy for Entra-registered apps.

.DESCRIPTION
    Microsoft Purview DLP requires a SEPARATE policy for the "Applications" workload.
    It cannot be combined with Exchange/SharePoint/OneDriveForBusiness.

    The -Locations JSON MUST include:
      - LocationSource: "Entra"
      - LocationType: "Individual"
    Omitting either causes "Location is invalid" error.

    The rule uses -RestrictAccess (not -BlockAccess) for Applications workload.

.PARAMETER AppId
    The Entra app registration ID to protect (default: Agent Warden Purview DLP app).

.PARAMETER AppDisplayName
    Display name for the app in the policy location.

.PARAMETER PolicyName
    Name of the DLP policy to create (default: "Agent Warden - Entra DLP").

.PARAMETER RuleName
    Name of the DLP rule to create (default: "Block PII via Entra App").

.EXAMPLE
    ./setup-dlp-entra-policy.ps1
    ./setup-dlp-entra-policy.ps1 -AppId "your-app-id" -AppDisplayName "Your App"
#>

param(
    [string]$AppId = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa",
    [string]$AppDisplayName = "Agent Warden Purview DLP",
    [string]$PolicyName = "Agent Warden - Entra DLP",
    [string]$RuleName = "Block PII via Entra App"
)

Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Security & Compliance PowerShell..."
Connect-IPPSSession
Write-Output "Connected!"

# ── Check if policy already exists ──
$existing = Get-DlpCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Write-Output ""
    Write-Output "Policy '$PolicyName' already exists (Workload: $($existing.Workload))"
    Write-Output "DistributionStatus: $($existing.DistributionStatus)"
    $confirm = Read-Host "Delete and recreate? (y/N)"
    if ($confirm -ne "y") {
        Write-Output "Aborted."
        exit 0
    }
    Write-Output "Removing existing rule and policy..."
    Remove-DlpComplianceRule -Identity $RuleName -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep 2
    Remove-DlpCompliancePolicy -Identity $PolicyName -Confirm:$false
    Write-Output "Waiting 20s for deletion to propagate..."
    Start-Sleep 20
}

# ── Create policy with Applications workload via -Locations JSON ──
# CRITICAL: LocationSource and LocationType are REQUIRED for Entra apps
$locJson = @"
[{
    "Workload": "Applications",
    "Location": "$AppId",
    "LocationDisplayName": "$AppDisplayName",
    "LocationSource": "Entra",
    "LocationType": "Individual",
    "Inclusions": [{"Type": "Tenant", "Identity": "All", "DisplayName": "All", "Name": "All"}]
}]
"@

Write-Output ""
Write-Output "Creating policy '$PolicyName' with Applications workload..."
Write-Output "  AppId: $AppId"
Write-Output "  LocationSource: Entra"
Write-Output "  LocationType: Individual"

New-DlpCompliancePolicy -Name $PolicyName `
    -Mode Enable `
    -Locations $locJson `
    -EnforcementPlanes @("Entra")

Start-Sleep 5

# ── Verify policy was created ──
$policy = Get-DlpCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue
if ($null -eq $policy) {
    Write-Error "Policy was NOT created. Check the Locations JSON format."
    exit 1
}
Write-Output "Policy created!"
Write-Output "  Workload: $($policy.Workload)"
Write-Output "  DistributionStatus: $($policy.DistributionStatus)"

# ── Define 28 SITs ──
$sits = @(
    @{Name="Credit Card Number"}
    @{Name="U.S. Social Security Number (SSN)"}
    @{Name="U.S. / U.K. Passport Number"}
    @{Name="Canada Passport Number"}
    @{Name="Australia Passport Number"}
    @{Name="Japan Passport Number"}
    @{Name="France Passport Number"}
    @{Name="German Passport Number"}
    @{Name="Italy Passport Number"}
    @{Name="Spain Passport Number"}
    @{Name="Netherlands Passport Number"}
    @{Name="Belgium Passport Number"}
    @{Name="Sweden Passport Number"}
    @{Name="Finland Passport Number"}
    @{Name="Austria Passport Number"}
    @{Name="Ireland Passport Number"}
    @{Name="South Korea Passport Number"}
    @{Name="Taiwan Passport Number"}
    @{Name="Poland Passport"}
    @{Name="Russian Passport Number (Domestic)"}
    @{Name="Russian Passport Number (International)"}
    @{Name="Russian Taxpayer Identification Number"}
    @{Name="Russia Physical Addresses"}
    @{Name="Japanese My Number Personal"}
    @{Name="Japanese My Number Corporate"}
    @{Name="Japan Resident Registration Number"}
    @{Name="U.S. Physical Addresses"}
    @{Name="Japan Physical Addresses"}
)

# ── Create rule with RestrictAccess (not BlockAccess) ──
# Applications workload uses -RestrictAccess, not -BlockAccess
Write-Output ""
Write-Output "Creating rule '$RuleName' with $($sits.Count) SITs..."

New-DlpComplianceRule -Name $RuleName `
    -Policy $PolicyName `
    -ContentContainsSensitiveInformation $sits `
    -RestrictAccess @(@{setting="UploadText"; value="Block"})

Start-Sleep 3

# ── Verify rule ──
$rule = Get-DlpComplianceRule -Identity $RuleName -ErrorAction SilentlyContinue
if ($null -eq $rule) {
    Write-Error "Rule was NOT created."
    exit 1
}

$sitsCount = ($rule.ContentContainsSensitiveInformation | Measure-Object).Count
Write-Output "Rule created!"
Write-Output "  SITs: $sitsCount"
Write-Output "  RestrictAccess: $($rule.RestrictAccess)"

# ── Summary ──
Write-Output ""
Write-Output "=== Setup Complete ==="
Write-Output "Policy: $PolicyName"
Write-Output "Rule:   $RuleName"
Write-Output "SITs:   $sitsCount"
Write-Output ""
Write-Output "NOTE: Policy distribution may take 1-24 hours."
Write-Output "Check status with:"
Write-Output "  Get-DlpCompliancePolicy -Identity '$PolicyName' | Select DistributionStatus"
