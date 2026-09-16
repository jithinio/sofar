//! Cross-initiative file conflicts from the Tier 0 open set
//! (`core/cross-conflicts.ts`, record-index 2.2).

use crate::index_tier0::Tier0Session;
use crate::text::cmp_utf16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossHolder {
    pub session: String,
    pub initiative: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossFileConflict {
    pub path: String,
    pub holders: Vec<CrossHolder>,
    pub initiatives: Vec<String>,
}

/// `crossConflictsFromOpenSessions`: my held files, seeded from the fold, that
/// an open session on ANOTHER initiative also holds.
#[must_use]
pub fn cross_conflicts_from_open_sessions(
    open: &[Tier0Session],
    initiative: &str,
    session: &str,
    files: &[String],
) -> Vec<CrossFileConflict> {
    let mut by_file: Vec<(String, Vec<CrossHolder>)> = Vec::new();
    for file in files {
        if by_file.iter().any(|(f, _)| f == file) {
            continue;
        }
        by_file.push((
            file.clone(),
            vec![CrossHolder {
                session: session.to_owned(),
                initiative: initiative.to_owned(),
            }],
        ));
    }
    if by_file.is_empty() {
        return Vec::new();
    }
    for holder in open {
        if holder.session == session {
            continue;
        }
        for file in &holder.files {
            if let Some((_, holders)) = by_file.iter_mut().find(|(f, _)| f == file) {
                holders.push(CrossHolder {
                    session: holder.session.clone(),
                    initiative: holder.initiative.clone(),
                });
            }
        }
    }
    let mut conflicts = Vec::new();
    for (path, mut holders) in by_file {
        let mut initiatives: Vec<String> = Vec::new();
        for h in &holders {
            if !initiatives.contains(&h.initiative) {
                initiatives.push(h.initiative.clone());
            }
        }
        initiatives.sort_by(|a, b| cmp_utf16(a, b));
        if initiatives.len() < 2 {
            continue;
        }
        holders.sort_by(|a, b| {
            if a.initiative == b.initiative {
                cmp_utf16(&a.session, &b.session)
            } else {
                cmp_utf16(&a.initiative, &b.initiative)
            }
        });
        conflicts.push(CrossFileConflict {
            path,
            holders,
            initiatives,
        });
    }
    conflicts.sort_by(|a, b| cmp_utf16(&a.path, &b.path));
    conflicts
}
