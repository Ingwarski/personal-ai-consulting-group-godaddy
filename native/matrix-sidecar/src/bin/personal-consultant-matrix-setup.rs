#[tokio::main]
async fn main() {
    let result =
        personal_consultant_matrix_sidecar::setup::run(std::env::args().skip(1).collect()).await;
    if let Err(error) = result {
        // Error vocabulary is static and deliberately excludes SDK error text,
        // credentials, homeserver responses, and private store content.
        println!(
            "{}",
            serde_json::json!({"version":1,"type":"setup_failed","error":error})
        );
        std::process::exit(1);
    }
}
