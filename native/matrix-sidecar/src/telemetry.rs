#[derive(Clone, Copy, Debug)]
pub enum SafeEvent {
    Started,
    Ready,
    ProtocolRejected,
    StoreQuarantined,
    PolicyDenied,
    MediaDenied,
    TransportFailed,
    Shutdown,
}

pub fn emit(event: SafeEvent) {
    eprintln!(
        "matrix_sidecar event={}",
        match event {
            SafeEvent::Started => "started",
            SafeEvent::Ready => "ready",
            SafeEvent::ProtocolRejected => "protocol_rejected",
            SafeEvent::StoreQuarantined => "store_quarantined",
            SafeEvent::PolicyDenied => "policy_denied",
            SafeEvent::MediaDenied => "media_denied",
            SafeEvent::TransportFailed => "transport_failed",
            SafeEvent::Shutdown => "shutdown",
        }
    );
}
