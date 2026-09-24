//! Insertion-ordered set and map — the JavaScript `Set` and `Map` iteration
//! contract the fold's side tables rely on (`voided`, `seenSessions`,
//! `guardSeen`, `blockNotes`): a re-insert keeps the original position, and
//! iteration is first-insertion order, which is the order the snapshot wire
//! serializes them in.

use std::collections::HashSet;

/// A `Set<string>`: membership in O(1), iteration in insertion order.
#[derive(Debug, Clone, Default)]
pub struct OrderedSet {
    items: Vec<String>,
    index: HashSet<String>,
}

impl OrderedSet {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `set.add(item)`; true when it was new.
    pub fn insert(&mut self, item: &str) -> bool {
        if self.index.contains(item) {
            return false;
        }
        self.index.insert(item.to_owned());
        self.items.push(item.to_owned());
        true
    }

    #[must_use]
    pub fn contains(&self, item: &str) -> bool {
        self.index.contains(item)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Members in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.items.iter().map(String::as_str)
    }
}

impl PartialEq for OrderedSet {
    fn eq(&self, other: &Self) -> bool {
        self.items == other.items
    }
}

impl<'a> FromIterator<&'a str> for OrderedSet {
    fn from_iter<I: IntoIterator<Item = &'a str>>(iter: I) -> Self {
        let mut set = OrderedSet::new();
        for item in iter {
            set.insert(item);
        }
        set
    }
}

impl FromIterator<String> for OrderedSet {
    fn from_iter<I: IntoIterator<Item = String>>(iter: I) -> Self {
        let mut set = OrderedSet::new();
        for item in iter {
            set.insert(&item);
        }
        set
    }
}

/// A `Map<string, string>`: `set` on an existing key keeps its position,
/// `delete` removes it, iteration is insertion order. Small by construction
/// (block notes are one per blocked task), so a scan is the index.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StringMap {
    entries: Vec<(String, String)>,
}

impl StringMap {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, key: &str, value: String) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key.to_owned(), value)),
        }
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(i) = self.entries.iter().position(|(k, _)| k == key) {
            self.entries.remove(i);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

// serde (rust-core 4.4, 01M39ED9): both persist in iteration order, the order
// the snapshot wire already uses for them, and rebuild through their own
// insert so membership and order come back together.

impl serde::Serialize for OrderedSet {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.iter())
    }
}

impl<'de> serde::Deserialize<'de> for OrderedSet {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let items: Vec<String> = serde::Deserialize::deserialize(d)?;
        let mut set = OrderedSet::new();
        for item in &items {
            set.insert(item);
        }
        Ok(set)
    }
}

impl serde::Serialize for StringMap {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.iter())
    }
}

impl<'de> serde::Deserialize<'de> for StringMap {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let pairs: Vec<(String, String)> = serde::Deserialize::deserialize(d)?;
        let mut map = StringMap::new();
        for (k, v) in pairs {
            map.set(&k, v);
        }
        Ok(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_keeps_first_insertion_order() {
        let mut s = OrderedSet::new();
        assert!(s.insert("b"));
        assert!(s.insert("a"));
        assert!(!s.insert("b"));
        assert_eq!(s.iter().collect::<Vec<_>>(), ["b", "a"]);
        assert!(s.contains("a") && !s.contains("c"));
    }

    #[test]
    fn map_set_keeps_position_and_delete_removes() {
        let mut m = StringMap::new();
        m.set("x", "1".into());
        m.set("y", "2".into());
        m.set("x", "3".into());
        assert_eq!(m.iter().collect::<Vec<_>>(), [("x", "3"), ("y", "2")]);
        m.remove("x");
        assert_eq!(m.get("x"), None);
        assert_eq!(m.len(), 1);
    }
}
