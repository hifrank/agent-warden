#!/usr/bin/env python3
"""Test processContent with both uploadText and downloadText activities."""
import json, urllib.request, subprocess, sys

TENANT = "2cf24558-0d31-439b-9c8d-6fdce3931ae7"
CLIENT_ID = subprocess.check_output(["printenv", "PURVIEW_DLP_CLIENT_ID"], text=True).strip() if not True else "d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
USER_ID = "7ade9412-3a6e-4b37-a3a8-51d8f81de596"

# Get secret from pod
secret = subprocess.check_output(
    ["kubectl", "exec", "-n", "tenant-demo-tenant", "openclaw-demo-tenant-0",
     "-c", "openclaw-gateway", "--", "printenv", "PURVIEW_DLP_CLIENT_SECRET"],
    text=True
).strip()

# Get token
token_body = f"client_id={CLIENT_ID}&client_secret={secret}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&grant_type=client_credentials"
req = urllib.request.Request(
    f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token",
    data=token_body.encode(), method="POST"
)
token = json.loads(urllib.request.urlopen(req).read())["access_token"]
print(f"Token: {len(token)} chars")

for activity in ["uploadText", "downloadText"]:
    body = json.dumps({"contentToProcess":{
        "contentEntries":[{
            "@odata.type": "microsoft.graph.processConversationMetadata",
            "identifier": f"test-{activity}",
            "content": {"@odata.type": "microsoft.graph.textContent",
                        "data": "Card Number: 4532015112830366 and SSN: 078-05-1120"},
            "name": "test", "correlationId": f"corr-{activity}",
            "sequenceNumber": 0, "isTruncated": False,
            "createdDateTime": "2026-03-31T09:00:00Z",
            "modifiedDateTime": "2026-03-31T09:00:00Z"
        }],
        "activityMetadata": {"activity": activity},
        "deviceMetadata": {"deviceType": "Managed",
                           "operatingSystemSpecifications": {
                               "operatingSystemPlatform": "Linux",
                               "operatingSystemVersion": "5.15"}},
        "protectedAppMetadata": {"name": "OpenClaw", "version": "0.5.2",
                                  "applicationLocation": {
                                      "@odata.type": "#microsoft.graph.policyLocationApplication",
                                      "value": CLIENT_ID}},
        "integratedAppMetadata": {"name": "OpenClaw", "version": "0.5.2"}
    }}).encode()

    req = urllib.request.Request(
        f"https://graph.microsoft.com/v1.0/users/{USER_ID}/dataSecurityAndGovernance/processContent",
        data=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST"
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    actions = resp.get("policyActions", [])
    print(f"\n{activity}: policyActions = {json.dumps(actions, indent=2)}")
    print(f"  protectionScopeState = {resp.get('protectionScopeState')}")
    print(f"  processingErrors = {resp.get('processingErrors')}")
