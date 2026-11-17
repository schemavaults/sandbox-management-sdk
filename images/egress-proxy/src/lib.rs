//! Egress proxy for Docker sandboxes with a `spec.network` allowlist. The
//! SDK's Docker provider runs one next to each such sandbox, as its only way
//! out; see the README, "Network allowlists".

pub mod cidr;
pub mod config;
pub mod health;
pub mod log;
pub mod policy;
pub mod proxy;
