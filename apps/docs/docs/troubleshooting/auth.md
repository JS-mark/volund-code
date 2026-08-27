# Authentication

If login fails, confirm the provider is reachable and the credential is active. Volund verifies before storing; a 4xx or invalid response must not write the credential.

Use `volund doctor --strict` to distinguish a missing credential from native or configuration failures. Never print the credential while debugging. Logout and repeat the masked login flow if storage is stale.
