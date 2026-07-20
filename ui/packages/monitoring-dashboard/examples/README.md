# Manifest Response Samples

These files are sanitized responses from:

```http
GET /pm/ddash/manifest/?dashboard=mo&id=1
```

They preserve the API 1.3 response shape while replacing managed object identifiers, addresses,
platform details, interface names, and descriptions. The interface catalog is intentionally
reduced to three representative entities so the sample remains suitable for review and frontend
development.

- `manifest-empty.json` represents a managed object without configured metrics.
- `manifest-device-health.json` represents device-level CPU, memory, and ping metrics.
- `manifest-interface-optical.json` represents device health, interface traffic and errors, and
  optical DOM metrics.

The `192.0.2.0/24` addresses belong to the TEST-NET-1 documentation range and do not identify a
real installation.
