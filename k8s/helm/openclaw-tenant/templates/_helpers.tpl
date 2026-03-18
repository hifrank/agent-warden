{{/* Resolve tier-specific storage config */}}
{{- define "openclaw-tenant.storageConfig" -}}
{{- $tier := .Values.tier -}}
{{- if eq $tier "enterprise" }}
{{- toYaml .Values.storage.enterprise }}
{{- else if eq $tier "pro" }}
{{- toYaml .Values.storage.pro }}
{{- else }}
{{- toYaml .Values.storage.free }}
{{- end }}
{{- end }}

{{/* Resolve tier-specific resource config */}}
{{- define "openclaw-tenant.resourceConfig" -}}
{{- $tier := .Values.tier -}}
{{- if eq $tier "enterprise" }}
{{- toYaml .Values.resources.enterprise }}
{{- else if eq $tier "pro" }}
{{- toYaml .Values.resources.pro }}
{{- else }}
{{- toYaml .Values.resources.free }}
{{- end }}
{{- end }}

{{/* Common labels */}}
{{- define "openclaw-tenant.labels" -}}
app.kubernetes.io/name: openclaw
app.kubernetes.io/instance: {{ .Values.tenantId }}
app.kubernetes.io/part-of: sentinel-mcp
openclaw.io/tenant: {{ .Values.tenantId }}
openclaw.io/tier: {{ .Values.tier }}
{{- end }}
