# Configure DLP policy for Agent Warden in Microsoft Purview
# This script connects to Security & Compliance powershell and sets up DLP rules
# that detect credit cards and SSN patterns with restrictAccess action

param(
    [string]$TenantId = $env:PURVIEW_DLP_TENANT_ID
)

$ErrorActionPreference = "Stop"

Write-Host "=== Step 1: Connect to Security & Compliance Center ===" -ForegroundColor Cyan
Write-Host "Connecting to tenant $TenantId..."

# Connect using the IPPSSession (Information Protection & Compliance)
try {
    Connect-IPPSSession -ShowBanner:$false
    Write-Host "Connected to Security & Compliance Center" -ForegroundColor Green
} catch {
    Write-Host "Failed to connect. You may need to authenticate interactively." -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    throw
}

Write-Host ""
Write-Host "=== Step 2: List existing DLP policies ===" -ForegroundColor Cyan
$policies = Get-DlpCompliancePolicy
if ($policies) {
    foreach ($p in $policies) {
        Write-Host "  Policy: $($p.Name) | Mode=$($p.Mode) | Enabled=$($p.Enabled)"
    }
} else {
    Write-Host "  (no DLP policies found)"
}

Write-Host ""
Write-Host "=== Step 3: Check for our policy ===" -ForegroundColor Cyan
$policyName = "Agent Warden - AI App DLP"
$existing = $policies | Where-Object { $_.Name -eq $policyName }

if ($existing) {
    Write-Host "  Found existing policy: $policyName (Mode=$($existing.Mode))" -ForegroundColor Yellow
    
    # List rules for this policy
    Write-Host ""
    Write-Host "=== Step 4: List rules for $policyName ===" -ForegroundColor Cyan
    $rules = Get-DlpComplianceRule -Policy $policyName
    if ($rules) {
        foreach ($r in $rules) {
            Write-Host "  Rule: $($r.Name) | Disabled=$($r.Disabled)"
            Write-Host "    ContentContainsSensitiveInformation: $($r.ContentContainsSensitiveInformation | ConvertTo-Json -Depth 3 -Compress)"
            Write-Host "    BlockAccess: $($r.BlockAccess)"
        }
    } else {
        Write-Host "  (no rules found — need to create)"
    }
} else {
    Write-Host "  Policy not found. Creating..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Step 5: Create/update DLP policy and rules ===" -ForegroundColor Cyan

if (-not $existing) {
    Write-Host "Creating DLP policy: $policyName"
    
    # Create the compliance policy targeting AI applications
    New-DlpCompliancePolicy -Name $policyName `
        -Mode "Enable" `
        -Comment "DLP policy for Agent Warden AI application. Detects and blocks sensitive PII (credit cards, SSN, passport numbers)." `
        -ThirdPartyAppDlpRestrictions @(@{
            AppName = "Agent Warden"
            AppId = $env:PURVIEW_DLP_CLIENT_ID
        })
    
    Write-Host "  Created policy" -ForegroundColor Green
} else {
    Write-Host "  Policy already exists, skipping creation"
}

# Check if rule exists
$ruleName = "Block Credit Card and SSN"
$existingRule = Get-DlpComplianceRule -Policy $policyName | Where-Object { $_.Name -eq $ruleName }

if (-not $existingRule) {
    Write-Host "Creating DLP rule: $ruleName"
    
    # Create rule with sensitive information types
    New-DlpComplianceRule -Name $ruleName `
        -Policy $policyName `
        -ContentContainsSensitiveInformation @(
            @{Name = "Credit Card Number"; minCount = 1; maxCount = -1; minConfidence = 85; maxConfidence = 100},
            @{Name = "U.S. Social Security Number (SSN)"; minCount = 1; maxCount = -1; minConfidence = 85; maxConfidence = 100}
        ) `
        -BlockAccess $true `
        -BlockAccessScope "All"
    
    Write-Host "  Created rule: $ruleName" -ForegroundColor Green
} else {
    Write-Host "  Rule already exists: $ruleName"
}

# Create additional rule for more PII types
$ruleName2 = "Block Passport and Bank Account"
$existingRule2 = Get-DlpComplianceRule -Policy $policyName | Where-Object { $_.Name -eq $ruleName2 }

if (-not $existingRule2) {
    Write-Host "Creating DLP rule: $ruleName2"
    
    New-DlpComplianceRule -Name $ruleName2 `
        -Policy $policyName `
        -ContentContainsSensitiveInformation @(
            @{Name = "U.S. / U.K. Passport Number"; minCount = 1; maxCount = -1; minConfidence = 75; maxConfidence = 100},
            @{Name = "U.S. Bank Account Number"; minCount = 1; maxCount = -1; minConfidence = 85; maxConfidence = 100}
        ) `
        -BlockAccess $true `
        -BlockAccessScope "All"
    
    Write-Host "  Created rule: $ruleName2" -ForegroundColor Green
} else {
    Write-Host "  Rule already exists: $ruleName2"
}

Write-Host ""
Write-Host "=== Final: Verify policy ===" -ForegroundColor Cyan
$finalPolicy = Get-DlpCompliancePolicy -Identity $policyName
Write-Host "Policy: $($finalPolicy.Name)"
Write-Host "  Mode: $($finalPolicy.Mode)"
Write-Host "  Enabled: $($finalPolicy.Enabled)"
Write-Host "  ThirdPartyAppDlp: $($finalPolicy.ThirdPartyAppDlpRestrictions | ConvertTo-Json -Compress)"

$finalRules = Get-DlpComplianceRule -Policy $policyName
foreach ($r in $finalRules) {
    Write-Host "  Rule: $($r.Name) | BlockAccess=$($r.BlockAccess)"
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "NOTE: DLP policy changes may take 15-60 minutes to propagate to the API."
Write-Host "After propagation, processContent should return policyActions with restrictAccess."
Write-Host ""

Disconnect-ExchangeOnline -Confirm:$false 2>$null
