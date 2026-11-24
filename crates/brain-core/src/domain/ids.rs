use crate::domain::errors::CoreError;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! define_uuid_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            #[must_use]
            pub fn new_v4() -> Self {
                Self(Uuid::new_v4().to_string())
            }

            pub fn parse(raw: &str) -> Result<Self, CoreError> {
                let parsed = Uuid::parse_str(raw.trim()).map_err(|_| {
                    CoreError::InvalidInput(format!("invalid {} UUID", stringify!($name)))
                })?;
                Ok(Self(parsed.to_string()))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Self::parse(&raw).map_err(serde::de::Error::custom)
            }
        }
    };
}

define_uuid_id!(VaultId);
define_uuid_id!(NoteId);
define_uuid_id!(ProposalId);
define_uuid_id!(RevisionId);
define_uuid_id!(OperationId);
define_uuid_id!(GrantId);
define_uuid_id!(EventId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_newtypes_validate_canonical_form() {
        let id = VaultId::new_v4();
        let parsed = VaultId::parse(id.as_str()).expect("valid uuid");
        assert_eq!(id, parsed);
        assert!(NoteId::parse("not-a-uuid").is_err());
    }
}
