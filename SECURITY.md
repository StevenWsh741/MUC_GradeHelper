# Security and privacy

Do not commit or share `.browser-profile/`. It contains local browser session data.

The desktop application keeps credentials and score baselines out of project files. The optional Android credential vault encrypts credentials with a non-exportable Android Keystore key, disables app backup, and never caches credential-bearing remote commands on the relay. If a privacy issue is found, stop the checker and desktop listener, clear the Android credential vault, remove local runtime data, and report the affected file and reproduction steps without including credentials, cookies, CAS tickets, pairing codes, or real grades.
