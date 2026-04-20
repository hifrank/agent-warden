# Update DLP rule "Block SSN and Credit Card" to include all credit card, passport, and address SITs
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to S&C PowerShell..."
Connect-IPPSSession
Write-Output "Connected!"

# All credit card, passport, and address related SITs
$sits = @(
    # ── Credit Card ──
    @{Name="Credit Card Number"}

    # ── U.S. PII ──
    @{Name="U.S. Social Security Number (SSN)"}

    # ── Passport ──
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

    # ── Russia ──
    @{Name="Russian Passport Number (Domestic)"}
    @{Name="Russian Passport Number (International)"}
    @{Name="Russian Taxpayer Identification Number"}
    @{Name="Russia Physical Addresses"}

    # ── Japan ──
    @{Name="Japanese My Number Personal"}
    @{Name="Japanese My Number Corporate"}
    @{Name="Japan Resident Registration Number"}

    # ── Physical Address ──
    @{Name="U.S. Physical Addresses"}
    @{Name="Japan Physical Addresses"}
)

Write-Output ""
Write-Output "Updating rule with $($sits.Count) SIT types..."
Write-Output ""

# Update the existing rule (not create new)
Set-DlpComplianceRule -Identity "Block SSN and Credit Card" `
    -ContentContainsSensitiveInformation $sits

Write-Output "Done! Rule updated."
Write-Output ""
Write-Output "=== Updated Rule ==="
Get-DlpComplianceRule -Identity "Block SSN and Credit Card" | Format-List Name,ContentContainsSensitiveInformation
