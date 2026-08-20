//! dsh-verifier-core — deterministic verification mathematics.
//!
//! This crate is the numerical core of the DSH-llm-as-a-verifier preset.
//! It is an original implementation of the published "LLM-as-a-Verifier"
//! methodology: fine-grained letter-scale scoring, expectation over token
//! log-probabilities, pairwise reward aggregation, probabilistic pivot
//! tournament selection, and checkpoint progress decoding.
//!
//! The same source compiles in two shapes:
//! * native `rlib` for `cargo test` (with std), and
//! * `no_std` `cdylib` for `wasm32-unknown-unknown`, exposing a tiny C ABI
//!   that the TypeScript preset loads without any npm runtime dependency.
//!
//! Maintained by Beijing Taiyin Zhaowu Technology Co., Ltd.
//! (北京太殷造物科技有限公司).

#![cfg_attr(all(target_arch = "wasm32", not(test)), no_std)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

#[cfg(all(target_arch = "wasm32", not(test)))]
extern crate alloc;

#[cfg(all(target_arch = "wasm32", not(test)))]
use alloc::{
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};

use core::fmt::Write as _;
use serde_json::{Map, Number, Value};

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/// Number of levels on the verifier's letter scale (A through T).
pub const GRANULARITY: usize = 20;

/// Verifier letters, best-to-worst for pairwise rewards.
pub const LETTERS: [char; GRANULARITY] = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
    'S', 'T',
];

const CORE_VERSION: &str = "0.1.0";

/// Score tag format expected from the verifier.
const SCORE_FORMAT: &str = "LETTER_A_TO_T";

/// Raw value of a pairwise-reward letter: A = 20 (best) down to T = 1.
fn pair_raw_value(letter: char) -> Option<f64> {
    match letter {
        'a'..='t' => LETTERS.iter().position(|c| c.eq_ignore_ascii_case(&letter)).map(|i| (GRANULARITY - i) as f64),
        'A'..='T' => LETTERS.iter().position(|c| *c == letter).map(|i| (GRANULARITY - i) as f64),
        _ => None,
    }
}

/// Progress value of a letter: A = 0% up to T = 100%.
fn progress_value(letter: char) -> Option<f64> {
    let idx = if letter.is_ascii_lowercase() {
        LETTERS.iter().position(|c| c.eq_ignore_ascii_case(&letter))
    } else {
        LETTERS.iter().position(|c| *c == letter)
    }?;
    Some(idx as f64 / (GRANULARITY - 1) as f64)
}

fn normalized_pair_score(raw: f64) -> f64 {
    ((raw - 1.0) / (GRANULARITY - 1) as f64).clamp(0.0, 1.0)
}

fn bradley_terry(ra: f64, rb: f64) -> f64 {
    let z = (ra - rb).clamp(-50.0, 50.0);
    1.0 / (1.0 + libm::exp(-z))
}

fn splitmix64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = splitmix64(self.0);
        self.0
    }

    /// Uniform index in `0..limit`, using rejection sampling.
    fn below(&mut self, limit: u64) -> usize {
        if limit <= 1 {
            return 0;
        }
        let threshold = u64::MAX - (u64::MAX % limit);
        loop {
            let x = self.next_u64();
            if x < threshold {
                return (x % limit) as usize;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Prompt construction (original wording)
// ---------------------------------------------------------------------------

const SCALE_DESCRIPTION: &str = concat!(
    "Use a 20-level letter scale from A (best) to T (worst):\n",
    "  A = clearly and completely solved, with output verified in the trace\n",
    "  B-D = solved with only minor issues\n",
    "  E-G = above average; mostly correct with some remaining issues\n",
    "  H-J = uncertain, leaning toward success\n",
    "  K-M = uncertain, leaning toward failure\n",
    "  N-P = below average; significant issues remain\n",
    "  Q-S = failed, with some partial progress visible\n",
    "  T = clearly and completely failed"
);

fn pair_prompt(input: &Value) -> Result<Value, String> {
    let problem = expect_string(input, "problem")?;
    let trace_a = expect_string(input, "traceA")?;
    let trace_b = expect_string(input, "traceB")?;
    let criterion = expect_object(input, "criterion")?;
    let criterion_name = expect_string(criterion, "name")?;
    let criterion_description = expect_string(criterion, "description")?;
    let ground_truth_note = optional_string(input, "groundTruthNote").unwrap_or("");
    let n_images = optional_usize(input, "nImages").unwrap_or(0);

    let mut out = String::new();
    out.push_str("You are a strict evaluator of two candidate attempts at the same task.\n");
    out.push_str("Trust observable tool output, not the agent's narration.\n\n");
    if !ground_truth_note.is_empty() {
        out.push_str("Evidence guidance:\n");
        out.push_str(ground_truth_note.trim());
        out.push_str("\n\n");
    }
    out.push_str("Task:\n");
    out.push_str(problem.trim());
    out.push_str("\n\n");
    if n_images > 0 {
        let _ = write!(
            out,
            "Attached images: {n_images} image(s) follow the text and are task context.\n\n"
        );
    }
    out.push_str("Candidate A:\n");
    out.push_str(trace_a.trim());
    out.push_str("\n\n");
    out.push_str("Candidate B:\n");
    out.push_str(trace_b.trim());
    out.push_str("\n\n");
    out.push_str("Rating scale:\n");
    out.push_str(SCALE_DESCRIPTION);
    out.push_str("\n\n");
    out.push_str("Criterion to score (ignore every other aspect):\n");
    out.push_str(criterion_name.trim());
    out.push_str(": ");
    out.push_str(criterion_description.trim());
    out.push_str("\n\n");
    out.push_str("Think about the evidence first, then end the reply with EXACTLY these two lines and nothing after them:\n");
    let _ = write!(
        out,
        "<score_A> {SCORE_FORMAT} </score_A>\n<score_B> {SCORE_FORMAT} </score_B>\n"
    );
    Ok(Value::String(out))
}

fn format_steps(steps: &[&str]) -> String {
    let mut out = String::new();
    for (index, step) in steps.iter().enumerate() {
        let _ = writeln!(out, "=== Agent step {} ===", index + 1);
        out.push_str(step.trim());
        out.push_str("\n\n");
    }
    out
}

fn progress_prompt(input: &Value) -> Result<Value, String> {
    let problem = expect_string(input, "problem")?;
    let steps = expect_string_array(input, "steps")?;
    let checkpoints = expect_usize_array(input, "checkpointSteps")?;
    if steps.is_empty() {
        return Err("progress prompt needs at least one step".into());
    }
    if checkpoints.is_empty() {
        return Err("progress prompt needs at least one checkpoint".into());
    }
    let n_images = optional_usize(input, "nImages").unwrap_or(0);

    let mut out = String::new();
    out.push_str("You are a skeptical auditor of an agent's partial progress on one task.\n");
    out.push_str("Agents routinely claim success while errors remain visible. Base every checkpoint judgement on the actual actions and observed output.\n\n");
    out.push_str("Task instruction:\n");
    out.push_str(problem.trim());
    out.push_str("\n\n");
    if n_images > 0 {
        let _ = write!(
            out,
            "Attached images: {n_images} image(s) follow the text; markers such as \"[Image i attached]\" in the steps refer to them.\n\n"
        );
    }
    let _ = write!(
        out,
        "Agent trajectory ({} steps; each step is one action with its observed output):\n",
        steps.len()
    );
    out.push_str(&format_steps(&steps));
    let _ = writeln!(
        out,
        "Score {} checkpoint(s). A checkpoint after step k asks: given everything through step k, would the task's hidden grader already accept the current state?",
        checkpoints.len()
    );
    out.push_str("Scale (inverted from the usual verifier scale):\n");
    out.push_str("  A = certainly not yet; nothing useful or a clearly wrong path\n");
    out.push_str("  B-G = leans no; partial work exists but key pieces are missing or broken\n");
    out.push_str("  H-M = uncertain; a plausible solution is forming but is not convincingly verified\n");
    out.push_str("  N-S = leans yes; the right artifacts appear to be in place with minor concerns\n");
    out.push_str("  T = essentially certain yes; observed output literally matches the task\n\n");
    out.push_str("Effort and confident narration are NOT progress. Successive checkpoints may rise, plateau, or fall.\n\n");
    for (index, step) in checkpoints.iter().enumerate() {
        let _ = writeln!(
            out,
            "  Checkpoint {} = state right after agent step {}",
            index + 1,
            step
        );
    }
    out.push_str("\nScore each checkpoint independently. Output EXACTLY one line per checkpoint in order, nothing else:\n");
    for index in 1..=checkpoints.len() {
        let _ = writeln!(out, "<c{index}>LETTER</c{index}>");
    }
    Ok(Value::String(out))
}

// ---------------------------------------------------------------------------
// Log-probability decoding
// ---------------------------------------------------------------------------

type Position = Vec<(String, f64)>;

fn parse_positions(value: &Value) -> Result<Vec<Position>, String> {
    let outer = value
        .as_array()
        .ok_or_else(|| "positions must be an array".to_string())?;
    let mut result = Vec::with_capacity(outer.len());
    for row in outer {
        let row = row
            .as_array()
            .ok_or_else(|| "each position must be an array".to_string())?;
        let mut entries = Vec::with_capacity(row.len());
        for item in row {
            let token = expect_string(item, "token")?.to_string();
            let logprob = expect_f64(item, "logprob")?;
            entries.push((token, logprob));
        }
        result.push(entries);
    }
    Ok(result)
}

/// Distribution of the token that follows the LAST occurrence of `<tag>` in
/// the joined token stream. Some tokenizers fuse the closing `>` with the
/// letter, so the variant without `>` is searched as well.
fn tag_distribution(tokens: &[String], positions: &[Position], tag: &str) -> Option<Position> {
    if tokens.is_empty() || positions.is_empty() {
        return None;
    }
    let open = format!("<{tag}>");
    let open_without_gt = &open[..open.len() - 1];
    let mut found: Option<Position> = None;
    let mut joined = String::new();
    for (index, token) in tokens.iter().enumerate() {
        joined.push_str(token);
        if index + 1 < positions.len() {
            let trimmed = joined.trim_end();
            if trimmed.ends_with(open.as_str()) || trimmed.ends_with(open_without_gt) {
                found = Some(positions[index + 1].clone());
            }
        }
    }
    found
}

fn letter_from_token(token: &str) -> Option<char> {
    token
        .trim()
        .trim_start_matches(|c: char| !c.is_ascii_alphabetic())
        .chars()
        .next()
        .and_then(|c| {
            let upper = c.to_ascii_uppercase();
            LETTERS.contains(&upper).then_some(upper)
        })
}

/// Expected raw scale value from the distribution after a tag.
fn expected_from_distribution(position: &Position, value_of: fn(char) -> Option<f64>) -> Option<f64> {
    let mut best_prob: [f64; GRANULARITY] = [0.0; GRANULARITY];
    let mut seen = false;
    for (token, logprob) in position {
        let Some(letter) = letter_from_token(token) else {
            continue;
        };
        if value_of(letter).is_none() {
            continue;
        }
        let probability = libm::exp(*logprob);
        let index = letter_index(letter);
        if probability > best_prob[index] {
            best_prob[index] = probability;
            seen = true;
        }
    }
    if !seen {
        return None;
    }
    let total: f64 = best_prob.iter().sum();
    if total <= 0.0 || !total.is_finite() {
        return None;
    }
    let mut expectation = 0.0;
    for (idx, probability) in best_prob.iter().enumerate() {
        let value = value_of(LETTERS[idx])?;
        expectation += value * probability / total;
    }
    Some(expectation)
}

fn letter_index(letter: char) -> usize {
    LETTERS.iter().position(|c| *c == letter).unwrap_or(0)
}

/// Last tagged letter found in plain text: `<tag>LETTER</tag>`.
fn tagged_letter_from_text(text: &str, tag: &str) -> Option<char> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut search_from = 0usize;
    let mut last = None;
    while let Some(relative) = text.get(search_from..)?.find(&open) {
        let open_at = search_from + relative;
        let body_at = open_at + open.len();
        if let Some(relative_close) = text.get(body_at..)?.find(&close) {
            let body = &text[body_at..body_at + relative_close];
            let mut chars = body.trim().chars();
            while let Some(c) = chars.next() {
                if c.is_ascii_alphabetic() {
                    let upper = c.to_ascii_uppercase();
                    if LETTERS.contains(&upper) {
                        last = Some(upper);
                    }
                    break;
                }
            }
            search_from = body_at + relative_close + close.len();
        } else {
            break;
        }
    }
    last
}

fn parse_optional_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key)?.as_array().map(|rows| {
        rows.iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    })
}

fn score_distribution_input(input: &Value) -> Result<(String, Vec<String>, Vec<Position>), String> {
    let text = optional_string(input, "text").unwrap_or("").to_string();
    let tokens = parse_optional_string_array(input, "tokens").unwrap_or_default();
    let positions = match input.get("positions") {
        Some(value) => parse_positions(value)?,
        None => Vec::new(),
    };
    Ok((text, tokens, positions))
}

fn extract_score(input: &Value) -> Result<Value, String> {
    let tag = expect_string(input, "tag")?;
    let (text, tokens, positions) = score_distribution_input(input)?;
    let raw = tag_distribution(&tokens, &positions, tag)
        .as_ref()
        .and_then(|position| expected_from_distribution(position, pair_raw_value))
        .or_else(|| tagged_letter_from_text(&text, tag).and_then(pair_raw_value));
    let score = raw.map(normalized_pair_score).unwrap_or(0.5);
    Ok(Value::from(score))
}

fn extract_progress(input: &Value) -> Result<Value, String> {
    let count = expect_usize(input, "count")?;
    let (text, tokens, positions) = score_distribution_input(input)?;
    let mut scores = Vec::with_capacity(count);
    for checkpoint in 1..=count {
        let tag = format!("c{checkpoint}");
        let value = tag_distribution(&tokens, &positions, &tag)
            .as_ref()
            .and_then(|position| expected_from_distribution(position, progress_value))
            .or_else(|| tagged_letter_from_text(&text, &tag).and_then(progress_value));
        scores.push(value.map(Value::from).unwrap_or(Value::Null));
    }
    // Bare one-letter-line fallback, applied only where tagged parsing failed.
    if scores.iter().any(|score| score.is_null()) {
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| {
                let mut chars = line.chars();
                matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
                    && chars.next().is_none()
            })
            .collect();
        if lines.len() == count {
            for (index, line) in lines.iter().enumerate() {
                if scores[index].is_null() {
                    if let Some(letter) = line.chars().next().and_then(|c| {
                        let upper = c.to_ascii_uppercase();
                        LETTERS.contains(&upper).then_some(upper)
                    }) {
                        if let Some(value) = progress_value(letter) {
                            scores[index] = Value::from(value);
                        }
                    }
                }
            }
        }
    }
    Ok(Value::Array(scores))
}

// ---------------------------------------------------------------------------
// Probabilistic Pivot Tournament
// ---------------------------------------------------------------------------

fn parse_comparisons(value: &Value, key: &str) -> Result<Vec<(usize, usize, f64, f64)>, String> {
    let rows = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array"))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let row = row
            .as_array()
            .ok_or_else(|| "comparison row must be [a, b, ra, rb]".to_string())?;
        if row.len() != 4 {
            return Err("comparison row must have exactly 4 items".into());
        }
        let a = expect_usize_at(&row, 0)?;
        let b = expect_usize_at(&row, 1)?;
        let ra = expect_f64_at(&row, 2)?;
        let rb = expect_f64_at(&row, 3)?;
        out.push((a, b, ra, rb));
    }
    Ok(out)
}

fn aggregate(comparisons: &[(usize, usize, f64, f64)], n: usize) -> (Vec<f64>, Vec<usize>) {
    let mut wins = vec![0.0f64; n];
    let mut counts = vec![0usize; n];
    for (a, b, ra, rb) in comparisons {
        if *a >= n || *b >= n || a == b {
            continue;
        }
        let pa = bradley_terry(*ra, *rb);
        wins[*a] += pa;
        counts[*a] += 1;
        wins[*b] += 1.0 - pa;
        counts[*b] += 1;
    }
    (wins, counts)
}

fn mean_preference(wins: &[f64], counts: &[usize]) -> Vec<f64> {
    wins.iter()
        .zip(counts)
        .map(|(wins, count)| if *count == 0 { 0.0 } else { *wins / *count as f64 })
        .collect()
}

fn rank_indices(means: &[f64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..means.len()).collect();
    order.sort_by(|a, b| means[*b].total_cmp(&means[*a]).then(a.cmp(b)));
    order
}

fn select_pivots(means: &[f64], pivots: usize) -> Vec<usize> {
    let mut order = rank_indices(means);
    order.truncate(pivots.min(means.len()));
    order.sort_unstable();
    order
}

fn pivot_pairs(n: usize, pivots: &[usize]) -> Vec<(usize, usize)> {
    let pivot_set: Vec<bool> = {
        let mut flags = vec![false; n];
        for pivot in pivots {
            if *pivot < n {
                flags[*pivot] = true;
            }
        }
        flags
    };
    let mut pairs = Vec::new();
    for candidate in 0..n {
        if pivot_set[candidate] {
            continue;
        }
        for pivot in pivots {
            pairs.push((candidate, *pivot));
        }
    }
    for (index, left) in pivots.iter().enumerate() {
        for right in pivots.iter().skip(index + 1) {
            pairs.push((*left, *right));
        }
    }
    pairs
}

fn ppt_ring(input: &Value) -> Result<Value, String> {
    let n = expect_usize(input, "n")?;
    let seed = expect_f64(input, "seed")? as i64 as u64;
    if n == 0 {
        return Ok(Value::Array(Vec::new()));
    }
    let mut order: Vec<usize> = (0..n).collect();
    let mut rng = Rng(seed);
    for index in (1..n).rev() {
        let swap = rng.below((index + 1) as u64);
        order.swap(index, swap);
    }
    let pairs: Vec<Value> = order
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let next = order[(index + 1) % n];
            Value::Array(vec![Value::from(*candidate as u64), Value::from(next as u64)])
        })
        .collect();
    Ok(Value::Array(pairs))
}

fn ppt_plan(input: &Value) -> Result<Value, String> {
    let n = expect_usize(input, "n")?;
    let pivots = expect_usize(input, "pivots")?;
    let comparisons = parse_comparisons(input, "comparisons")?;
    let (wins, counts) = aggregate(&comparisons, n);
    let means = mean_preference(&wins, &counts);
    let chosen = select_pivots(&means, pivots);
    let pairs = pivot_pairs(n, &chosen);
    Ok(object(vec![
        (
            "pivots",
            Value::Array(chosen.iter().map(|p| Value::from(*p as u64)).collect()),
        ),
        (
            "pivotPairs",
            Value::Array(
                pairs
                    .iter()
                    .map(|(a, b)| Value::Array(vec![Value::from(*a as u64), Value::from(*b as u64)]))
                    .collect(),
            ),
        ),
    ]))
}

fn ppt_result(input: &Value) -> Result<Value, String> {
    let n = expect_usize(input, "n")?;
    let comparisons = parse_comparisons(input, "comparisons")?;
    if n == 0 {
        return Err("n must be positive".into());
    }
    let (wins, counts) = aggregate(&comparisons, n);
    let means = mean_preference(&wins, &counts);
    let ranking = rank_indices(&means);
    let best = ranking.first().copied().unwrap_or(0);
    Ok(object(vec![
        ("bestIndex", Value::from(best as u64)),
        (
            "scores",
            Value::Array(means.iter().map(|score| num(*score)).collect()),
        ),
        (
            "ranking",
            Value::Array(ranking.iter().map(|index| Value::from(*index as u64)).collect()),
        ),
        ("nComparisons", Value::from(comparisons.len() as u64)),
    ]))
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn num(value: f64) -> Value {
    Value::Number(Number::from_f64(value).unwrap_or_else(|| Number::from(0)))
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

fn error_message(message: &str) -> Value {
    object(vec![
        ("ok", Value::Bool(false)),
        ("error", Value::String(message.to_string())),
    ])
}

fn success(value: Value) -> Value {
    object(vec![("ok", Value::Bool(true)), ("value", value)])
}

fn expect_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn expect_object<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value
        .get(key)
        .filter(|item| item.is_object())
        .ok_or_else(|| format!("{key} must be an object"))
}

fn expect_f64(value: &Value, key: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{key} must be a number"))
}

fn expect_usize(value: &Value, key: &str) -> Result<usize, String> {
    let number = value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} must be a non-negative integer"))?;
    Ok(number as usize)
}

fn optional_usize(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

fn expect_f64_at(value: &[Value], index: usize) -> Result<f64, String> {
    value
        .get(index)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("item {index} must be a number"))
}

fn expect_usize_at(value: &[Value], index: usize) -> Result<usize, String> {
    value
        .get(index)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| format!("item {index} must be a non-negative integer"))
}

fn expect_string_array<'a>(value: &'a Value, key: &str) -> Result<Vec<&'a str>, String> {
    let rows = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array of strings"))?;
    rows.iter()
        .map(|item| {
            item.as_str()
                .ok_or_else(|| format!("{key} must contain only strings"))
        })
        .collect()
}

fn expect_usize_array(value: &Value, key: &str) -> Result<Vec<usize>, String> {
    let rows = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array of integers"))?;
    rows.iter()
        .map(|item| {
            item.as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| format!("{key} must contain only non-negative integers"))
        })
        .collect()
}

fn dispatch(op: &str, input: &Value) -> Value {
    let result = match op {
        "version" => Ok(object(vec![("version", Value::String(CORE_VERSION.into()))])),
        "pair_prompt" => pair_prompt(input),
        "progress_prompt" => progress_prompt(input),
        "extract_score" => extract_score(input),
        "extract_progress" => extract_progress(input),
        "ppt_ring" => ppt_ring(input),
        "ppt_plan" => ppt_plan(input),
        "ppt_result" => ppt_result(input),
        _ => Err(format!("unknown core operation: {op}")),
    };
    match result {
        Ok(value) => success(value),
        Err(message) => error_message(&message),
    }
}

// ---------------------------------------------------------------------------
// WebAssembly ABI (no_std, zero npm glue)
// ---------------------------------------------------------------------------

#[cfg(all(target_arch = "wasm32", not(test)))]
mod wasm_abi {
    use super::*;
    use alloc::alloc::{alloc, dealloc, Layout};
    use core::ptr;

    /// Fixed heap carved from the wasm data segment. Prompts for large
    /// trajectories are buffered in the caller before crossing the ABI, and
    /// 32 MiB is generous for the JSON envelopes this core exchanges.
    const HEAP_SIZE: usize = 32 * 1024 * 1024;

    #[repr(align(16))]
    #[allow(dead_code)]
    struct Heap([u8; HEAP_SIZE]);

    static mut HEAP: Heap = Heap([0u8; HEAP_SIZE]);
    static mut ALLOCATOR_READY: bool = false;

    #[global_allocator]
    static ALLOCATOR: linked_list_allocator::LockedHeap = linked_list_allocator::LockedHeap::empty();

    fn ensure_allocator() {
        unsafe {
            if !ALLOCATOR_READY {
                let start = core::ptr::addr_of_mut!(HEAP).cast::<u8>();
                ALLOCATOR.lock().init(start, HEAP_SIZE);
                ALLOCATOR_READY = true;
            }
        }
    }

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        loop {}
    }

    #[no_mangle]
    pub extern "C" fn lv_init() {
        ensure_allocator();
    }

    /// Allocate `len` bytes and return the pointer (0 on failure).
    #[no_mangle]
    pub extern "C" fn lv_alloc(len: u32) -> u32 {
        ensure_allocator();
        if len == 0 {
            return 0;
        }
        let layout = match Layout::array::<u8>(len as usize) {
            Ok(layout) => layout,
            Err(_) => return 0,
        };
        unsafe { alloc(layout) as u32 }
    }

    /// Free an allocation previously returned by `lv_alloc` or a dispatch
    /// result. Idempotent for null pointers.
    #[no_mangle]
    pub extern "C" fn lv_free(ptr: u32, len: u32) {
        if ptr == 0 || len == 0 {
            return;
        }
        let layout = match Layout::array::<u8>(len as usize) {
            Ok(layout) => layout,
            Err(_) => return,
        };
        unsafe { dealloc(ptr as *mut u8, layout) }
    }

    /// Copy input bytes into the heap and return `ptr:u32 << 32 | len:u32`.
    unsafe fn emit(bytes: &[u8]) -> u64 {
        let ptr = lv_alloc(bytes.len() as u32);
        if ptr == 0 {
            return 0;
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        ((ptr as u64) << 32) | bytes.len() as u64
    }

    /// Run one core operation. `op` and `input` point to UTF-8 JSON strings.
    #[no_mangle]
    pub extern "C" fn lv_dispatch(op_ptr: u32, op_len: u32, input_ptr: u32, input_len: u32) -> u64 {
        ensure_allocator();
        let op = match unsafe {
            core::str::from_utf8(core::slice::from_raw_parts(op_ptr as *const u8, op_len as usize))
        } {
            Ok(op) => op,
            Err(_) => {
                let bytes = serde_json::to_vec(&error_message("op must be UTF-8"))
                    .unwrap_or_else(|_| alloc::vec![b'{', b'}']);
                return unsafe { emit(&bytes) };
            }
        };
        let input = match unsafe {
            core::str::from_utf8(core::slice::from_raw_parts(input_ptr as *const u8, input_len as usize))
        } {
            Ok(input) => input,
            Err(_) => {
                let bytes = serde_json::to_vec(&error_message("input must be UTF-8"))
                    .unwrap_or_else(|_| alloc::vec![b'{', b'}']);
                return unsafe { emit(&bytes) };
            }
        };
        let parsed = match serde_json::from_slice::<Value>(input.as_bytes()) {
            Ok(value) => value,
            Err(error) => {
                let bytes = serde_json::to_vec(&error_message(&format!("invalid input JSON: {error}")))
                    .unwrap_or_else(|_| alloc::vec![b'{', b'}']);
                return unsafe { emit(&bytes) };
            }
        };
        let output = dispatch(op, &parsed);
        let bytes = serde_json::to_vec(&output).unwrap_or_else(|_| alloc::vec![b'{', b'}']);
        unsafe { emit(&bytes) }
    }
}

// ---------------------------------------------------------------------------
// Native tests (cargo test on the host target)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        serde_json::from_str(json).expect("valid test JSON")
    }

    fn pair_input() -> Value {
        parse(
            r#"{
                "problem": "Reverse a string.",
                "traceA": "agent A trace",
                "traceB": "agent B trace",
                "criterion": {"name": "Correctness", "description": "Does it reverse?"},
                "groundTruthNote": "Trust output only.",
                "nImages": 0
            }"#,
        )
    }

    #[test]
    fn pair_prompt_keeps_criterion_at_tail_for_prefix_caching() {
        let prompt = pair_prompt(&pair_input()).expect("prompt builds");
        let prompt = prompt.as_str().expect("string result");
        let criterion_at = prompt.rfind("Correctness").expect("criterion present");
        let first_tag_at = prompt.rfind("<score_A>").expect("tag present");
        assert!(criterion_at > prompt.rfind("Candidate B:").expect("candidate B present"));
        assert!(first_tag_at > criterion_at, "tags stay at the very end");
    }

    #[test]
    fn extract_score_prefers_logprob_expectation() {
        let input = parse(
            r#"{
                "text": "<score_A> B </score_A>",
                "tag": "score_A",
                "tokens": ["<score_", "A>", " ", "A", " </score_A>"],
                "positions": [
                    [{"token": "<score_", "logprob": -0.1}],
                    [{"token": "A>", "logprob": -0.1}],
                    [{"token": " ", "logprob": -0.1}],
                    [{"token": "A", "logprob": -0.05}, {"token": "C", "logprob": -2.05}],
                    [{"token": " </score_A>", "logprob": 0.0}]
                ]
            }"#,
        );
        let score = extract_score(&input).expect("score extracts");
        let score = score.as_f64().expect("number");
        assert!(score > 0.94, "A dominates, expected near 1.0, got {score}");
    }

    #[test]
    fn extract_score_falls_back_to_text() {
        let input = parse(
            r#"{"text": "analysis\n<score_A> D </score_A>", "tag": "score_A", "tokens": [], "positions": []}"#,
        );
        let score = extract_score(&input).expect("score extracts");
        let score = score.as_f64().expect("number");
        let expected = normalized_pair_score(pair_raw_value('D').expect("D is valid"));
        assert!((score - expected).abs() < 1e-9);
    }

    #[test]
    fn progress_scale_inverts_letters() {
        assert_eq!(progress_value('A'), Some(0.0));
        assert_eq!(progress_value('T'), Some(1.0));
        assert_eq!(pair_raw_value('A'), Some(20.0));
        assert_eq!(pair_raw_value('T'), Some(1.0));
    }

    #[test]
    fn progress_extraction_decodes_tagged_letters() {
        let input = parse(
            r#"{
                "text": "<c1>A</c1>\n<c2>J</c2>\n<c3>T</c3>",
                "count": 3,
                "tokens": [],
                "positions": []
            }"#,
        );
        let scores = extract_progress(&input).expect("progress extracts");
        let scores = scores.as_array().expect("array");
        assert_eq!(scores[0].as_f64(), Some(0.0));
        assert!((scores[1].as_f64().expect("number") - 9.0 / 19.0).abs() < 1e-9);
        assert_eq!(scores[2].as_f64(), Some(1.0));
    }

    #[test]
    fn ring_is_a_hamiltonian_cycle_and_seed_is_deterministic() {
        let input = parse(r#"{"n": 8, "seed": 42}"#);
        let ring = ppt_ring(&input).expect("ring builds");
        let ring = ring.as_array().expect("array");
        assert_eq!(ring.len(), 8);
        let again = ppt_ring(&input).expect("ring rebuilds");
        assert_eq!(ring, again.as_array().expect("array"));
    }

    #[test]
    fn pivot_tournament_prefers_the_strong_candidate() {
        let comparisons: Vec<Value> = vec![
            Value::Array(vec![Value::from(0u64), Value::from(1u64), Value::from(0.9f64), Value::from(0.2f64)]),
            Value::Array(vec![Value::from(1u64), Value::from(2u64), Value::from(0.1f64), Value::from(0.1f64)]),
            Value::Array(vec![Value::from(2u64), Value::from(0u64), Value::from(0.3f64), Value::from(0.8f64)]),
        ];
        let result = ppt_result(&object(vec![("n", Value::from(3u64)), ("comparisons", Value::Array(comparisons))]))
            .expect("tournament resolves");
        assert_eq!(result.get("bestIndex").and_then(Value::as_u64), Some(0));
        assert_eq!(result.get("ranking").and_then(Value::as_array).map(Vec::len), Some(3));
    }

    #[test]
    fn unknown_operation_returns_an_error_envelope() {
        let envelope = dispatch("nope", &parse("{}"));
        assert_eq!(envelope.get("ok").and_then(Value::as_bool), Some(false));
    }
}
