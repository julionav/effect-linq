//! The experiment behind "should change detection be native code?".
//!
//! Compares two row-major matrices of f64 (a snapshot and the current values)
//! and writes the indices of the rows that differ. This is the best case for
//! native code: numbers only, already laid out contiguously.
//!
//!     rustc --target wasm32-wasip1 -O --crate-type cdylib -C panic=abort \
//!       -o bench/wasm/diff.wasm bench/wasm/diff.rs
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub unsafe extern "C" fn diff(
    snapshot: *const u64,
    current: *const u64,
    rows: usize,
    columns: usize,
    out: *mut u32,
) -> usize {
    let mut found = 0;
    for row in 0..rows {
        let a = snapshot.add(row * columns);
        let b = current.add(row * columns);
        let mut changed = 0u64;
        for column in 0..columns {
            changed |= *a.add(column) ^ *b.add(column);
        }
        if changed != 0 {
            *out.add(found) = row as u32;
            found += 1;
        }
    }
    found
}
