//! NON-PRODUCTION feasibility tests. No SQL connection or application integration.
//! Tests the pinned SDK cipher, not a replacement for Matrix encryption.

#[cfg(test)]
mod tests {
    use matrix_sdk_store_encryption::StoreCipher;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Coordinates {
        store: String,
        family: String,
        record: Vec<u8>,
        schema: u32,
    }

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        coordinates: Coordinates,
        payload: Vec<u8>,
    }

    // Deliberately does not return a SDK/serde error containing input data.
    fn read(
        cipher: &StoreCipher,
        expected: &Coordinates,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, &'static str> {
        let envelope: Envelope = cipher
            .decrypt_value(ciphertext)
            .map_err(|_| "record unavailable")?;
        if &envelope.coordinates != expected {
            return Err("record unavailable");
        }
        Ok(envelope.payload)
    }

    fn coordinates() -> Coordinates {
        Coordinates {
            store: "synthetic-device-A".into(),
            family: "olm-session".into(),
            record: "!кімната:example.test/сеанс".as_bytes().to_vec(),
            schema: 1,
        }
    }

    fn encrypt(cipher: &StoreCipher, coordinates: Coordinates) -> Vec<u8> {
        cipher
            .encrypt_value(&Envelope {
                coordinates,
                payload: "synthetic private state — Привіт".as_bytes().to_vec(),
            })
            .unwrap()
    }

    #[test]
    fn external_key_restores_cipher_and_unicode_record() {
        let cipher = StoreCipher::new().unwrap();
        let original = coordinates();
        let ciphertext = encrypt(&cipher, original.clone());
        let export = cipher.export_with_key(&[7; 32]).unwrap();
        let restored = StoreCipher::import_with_key(&[7; 32], &export).unwrap();
        assert_eq!(
            read(&restored, &original, &ciphertext).unwrap(),
            "synthetic private state — Привіт".as_bytes()
        );
        assert_eq!(
            cipher.hash_key("olm-session", &original.record),
            restored.hash_key("olm-session", &original.record)
        );
    }

    #[test]
    fn wrong_external_key_cannot_restore_cipher() {
        let export = StoreCipher::new()
            .unwrap()
            .export_with_key(&[7; 32])
            .unwrap();
        assert!(StoreCipher::import_with_key(&[8; 32], &export).is_err());
    }

    #[test]
    fn ciphertext_cannot_move_between_store_family_key_or_schema() {
        let cipher = StoreCipher::new().unwrap();
        let original = coordinates();
        let ciphertext = encrypt(&cipher, original.clone());
        let mut variants = vec![original.clone(); 4];
        variants[0].store = "synthetic-device-B".into();
        variants[1].family = "inbound-group-session".into();
        variants[2].record = b"different-record".to_vec();
        variants[3].schema = 2;
        for wrong_coordinates in variants {
            assert_eq!(
                read(&cipher, &wrong_coordinates, &ciphertext),
                Err("record unavailable")
            );
        }
    }

    #[test]
    fn modified_truncated_or_foreign_ciphertext_is_rejected() {
        let cipher = StoreCipher::new().unwrap();
        let original = coordinates();
        let ciphertext = encrypt(&cipher, original.clone());
        let mut modified = ciphertext.clone();
        let midpoint = modified.len() / 2;
        modified[midpoint] ^= 1;
        assert!(read(&cipher, &original, &modified).is_err());
        assert!(read(&cipher, &original, &ciphertext[..midpoint]).is_err());
        assert!(read(&cipher, &original, &[]).is_err());
        let other = StoreCipher::new().unwrap();
        assert!(read(&other, &original, &ciphertext).is_err());
    }

    #[test]
    fn repeated_encryption_is_randomized() {
        let cipher = StoreCipher::new().unwrap();
        assert_ne!(
            encrypt(&cipher, coordinates()),
            encrypt(&cipher, coordinates())
        );
    }

    #[test]
    fn lookup_hashes_are_family_separated() {
        let cipher = StoreCipher::new().unwrap();
        let record = coordinates().record;
        assert_ne!(
            cipher.hash_key("olm-session", &record),
            cipher.hash_key("inbound-group-session", &record)
        );
    }
}
