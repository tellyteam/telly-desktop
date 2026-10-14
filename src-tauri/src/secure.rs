//! Private storage. The provider login is kept in the system's credential store (macOS Keychain,
//! Windows Credential Manager). Everything else telly remembers (history, progress, My List,
//! settings) is a small JSON file, encrypted with AES-256-GCM under a key that also lives in the
//! credential store. Xtream stream URLs embed the login, so none of it is written in the clear.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::path::PathBuf;
use std::sync::Mutex;

const SERVICE: &str = "io.github.tellyteam.telly";
const DATA_KEY: &str = "data-key";
const NONCE_LEN: usize = 12;

pub struct Secure {
    dir: PathBuf,
    /// Read from the credential store once, so the system asks at most once per launch.
    key: Mutex<Option<Key<Aes256Gcm>>>,
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// Store names become file names, so they're limited to a safe alphabet.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Secure {
    pub fn new(dir: PathBuf) -> Self {
        Secure { dir, key: Mutex::new(None) }
    }

    pub fn secret_get(&self, name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn secret_set(&self, name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn secret_delete(&self, name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn key(&self) -> Result<Key<Aes256Gcm>, String> {
        let mut cached = self.key.lock().map_err(|_| "key lock poisoned")?;
        if let Some(k) = *cached {
            return Ok(k);
        }
        let key = match self.secret_get(DATA_KEY)? {
            Some(b64) => {
                let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
                if bytes.len() != 32 {
                    return Err("The stored data key is damaged".into());
                }
                *Key::<Aes256Gcm>::from_slice(&bytes)
            }
            None => {
                let k = Aes256Gcm::generate_key(OsRng);
                self.secret_set(DATA_KEY, &STANDARD.encode(k))?;
                // Files written under an old key can no longer be read; start them afresh.
                let _ = std::fs::remove_dir_all(&self.dir);
                k
            }
        };
        *cached = Some(key);
        Ok(key)
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        if !valid_name(name) {
            return Err(format!("Invalid store name: {name}"));
        }
        Ok(self.dir.join(format!("{name}.bin")))
    }

    pub fn read(&self, name: &str) -> Result<Option<String>, String> {
        let path = self.path(name)?;
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        Ok(decrypt(&self.key()?, &data))
    }

    pub fn write(&self, name: &str, text: &str) -> Result<(), String> {
        let path = self.path(name)?;
        let data = encrypt(&self.key()?, text)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        // Write then rename, so a crash mid-write never leaves a half file.
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn encrypt(key: &Key<Aes256Gcm>, text: &str) -> Result<Vec<u8>, String> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = Aes256Gcm::new(key).encrypt(&nonce, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok([nonce.as_slice(), &sealed].concat())
}

/// None when the file is damaged or was written under another key; callers then start empty.
fn decrypt(key: &Key<Aes256Gcm>, data: &[u8]) -> Option<String> {
    if data.len() < NONCE_LEN {
        return None;
    }
    let (nonce, sealed) = data.split_at(NONCE_LEN);
    let plain = Aes256Gcm::new(key).decrypt(Nonce::from_slice(nonce), sealed).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_and_decrypts() {
        let key = Aes256Gcm::generate_key(OsRng);
        let sealed = encrypt(&key, "{\"a\":1}").unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("\"a\""));
        assert_eq!(decrypt(&key, &sealed).as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn rejects_other_keys_and_damage() {
        let sealed = encrypt(&Aes256Gcm::generate_key(OsRng), "x").unwrap();
        assert_eq!(decrypt(&Aes256Gcm::generate_key(OsRng), &sealed), None);
        assert_eq!(decrypt(&Aes256Gcm::generate_key(OsRng), b"short"), None);
    }

    #[test]
    fn store_names_are_restricted() {
        assert!(valid_name("history"));
        assert!(valid_name("watch_progress-2"));
        assert!(!valid_name("../evil"));
        assert!(!valid_name(""));
        assert!(!valid_name("a/b"));
    }
}
