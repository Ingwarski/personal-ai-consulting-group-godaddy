//! The unmodified SDK 0.18 contract suites against isolated, real MySQL rows.
//! Enabling this feature requires the test database; absence is a test failure.

use std::{cell::RefCell, collections::HashMap, sync::Arc};

use super::MySqlCryptoStore;
use crate::Backend;
use matrix_sdk_crypto::{cryptostore_integration_tests, cryptostore_integration_tests_time};

thread_local! {
    // SDK async_test uses a current-thread runtime on a distinct libtest thread.
    // A process-global pool registry outlives that runtime and cannot be reused
    // or closed reliably from a subsequent test's runtime.
    static STORES: RefCell<HashMap<String, Arc<Backend>>> = RefCell::new(HashMap::new());
}

async fn get_store(name: &str, _passphrase: Option<&str>, clear_data: bool) -> MySqlCryptoStore {
    // Backend always uses a synthetic 32-byte encryption key. The SDK's optional
    // free-form passphrase parameter is not our key-derivation API; its test still
    // exercises encrypted durable account storage, not legacy passphrase parsing.
    // Never retain a RefCell borrow across an await. Clones here account for the
    // second Arc below; the registry is the only other owner of inactive stores.
    let inactive = STORES.with(|stores| {
        stores
            .borrow()
            .iter()
            .filter(|(existing_name, backend)| {
                existing_name.as_str() != name && Arc::strong_count(backend) == 1
            })
            .map(|(_, backend)| backend.clone())
            .collect::<Vec<_>>()
    });
    for backend in inactive {
        if !backend.is_closed().await {
            backend
                .close()
                .await
                .expect("close inactive crypto-test database");
        }
    }
    let previous = STORES.with(|stores| stores.borrow().get(name).cloned());
    let backend = if clear_data || previous.is_none() {
        if let Some(previous) = previous {
            assert_eq!(
                Arc::strong_count(&previous),
                2,
                "cannot replace an active crypto-test namespace"
            );
            if !previous.is_closed().await {
                previous
                    .close()
                    .await
                    .expect("close replaced crypto-test database");
            }
        }
        let backend = crate::test_support::backend()
            .await
            .expect("provision isolated MySQL crypto-test namespace");
        STORES.with(|stores| stores.borrow_mut().insert(name.to_owned(), backend.clone()));
        backend
    } else {
        previous.expect("existing test namespace")
    };
    if backend.is_closed().await {
        backend
            .reopen()
            .await
            .expect("reopen isolated test database");
    }
    // Return a genuinely fresh SDK adapter, not cached account/session objects.
    MySqlCryptoStore::new(backend)
}

cryptostore_integration_tests!();
cryptostore_integration_tests_time!();
