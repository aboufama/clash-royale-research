/* Locally authored host observer. No game implementation or guest bytes. */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unicorn/unicorn.h>

typedef uc_err (*stop_fn)(uc_engine *);
typedef uc_err (*read_fn)(uc_engine *, int, void *);
typedef struct { uint64_t low, high; } guard_range;
typedef struct {
    stop_fn stop;
    read_fn read;
    guard_range ranges[8];
    uint32_t range_count;
    int32_t pc_register;
    uint64_t address, pc;
    int32_t access, size, read_error, stop_error;
    uint32_t violated;
} guard_state;

size_t cr_guard_size(void) { return sizeof(guard_state); }

int cr_guard_overlap(uint64_t address, uint64_t length,
                     uint64_t low, uint64_t high) {
    /* Same unbounded interval predicate as Python, without unsigned overflow. */
    return length != 0 && address < high &&
           (address >= low || length > low - address);
}

int cr_guard_init(guard_state *state, void *stop, void *read, int pc_register,
                  const guard_range *ranges, unsigned count) {
    if (!state || !stop || !read || !ranges || !count || count > 8) return -1;
    for (unsigned i = 0; i < count; ++i)
        if (ranges[i].low >= ranges[i].high) return -2;
    memset(state, 0, sizeof(*state));
    state->stop = (stop_fn)stop;
    state->read = (read_fn)read;
    state->pc_register = pc_register;
    state->range_count = count;
    memcpy(state->ranges, ranges, count * sizeof(*ranges));
    return 0;
}

void cr_guard_reset(guard_state *state) {
    state->violated = 0;
    state->address = state->pc = 0;
    state->access = state->size = state->read_error = state->stop_error = 0;
}

void cr_guard_hook(uc_engine *uc, uc_mem_type access, uint64_t address,
                   int size, int64_t value, void *user_data) {
    (void)value;
    guard_state *state = user_data;
    if (size <= 0) return;
    for (unsigned i = 0; i < state->range_count; ++i) {
        if (!cr_guard_overlap(address, (uint64_t)size,
                              state->ranges[i].low, state->ranges[i].high)) continue;
        if (!state->violated) {
            state->address = address;
            state->size = size;
            state->access = access;
            state->read_error = state->read(uc, state->pc_register, &state->pc);
            state->violated = 1;
        }
        uc_err stop_error = state->stop(uc);
        if (stop_error != UC_ERR_OK && state->stop_error == UC_ERR_OK)
            state->stop_error = stop_error;
        return;
    }
}
