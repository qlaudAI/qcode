// OS-native credential storage. Tauri-exposed commands the React side
// calls to persist the qlaud API key.
//
//   secret_set(service, account, value)  → write to keychain
//   secret_get(service, account)         → read; returns None if absent
//   secret_del(service, account)         → delete (used on sign-out)
//
// The `service` is always "ai.qlaud.qcode" today, but we accept it as
// a parameter so future qlaud apps can share the keychain backend
// without colliding namespaces.

use keyring::Entry;

#[tauri::command]
pub fn secret_set(service: String, account: String, value: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(stringify)?;
    entry.set_password(&value).map_err(stringify)?;
    Ok(())
}

#[tauri::command]
pub fn secret_get(service: String, account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, &account).map_err(stringify)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(stringify(e)),
    }
}

#[tauri::command]
pub fn secret_del(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(stringify)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        // Deleting a non-existent entry is a no-op for our caller's
        // intent (e.g. signing out when no key was ever stored).
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(stringify(e)),
    }
}

fn stringify(e: keyring::Error) -> String {
    e.to_string()
}
