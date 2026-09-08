#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().is_some_and(|arg| {
        matches!(
            arg.as_str(),
            "--provision-mysql-schema" | "--import-mysql" | "--activate-mysql"
        )
    }) {
        if personal_consultant_matrix_sidecar::migration::run(&arguments)
            .await
            .is_err()
        {
            println!("{{\"migration\":\"failed\"}}");
            std::process::exit(1);
        }
        return;
    }
    let result = personal_consultant_matrix_sidecar::setup::run(arguments).await;
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
