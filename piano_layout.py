notes = ["C ", "C#", "D ", "D#", "E ", "F ", "F#", "G ", "G#", "A ", "A#", "B "]

# for a in range(13):
#     for b in range(13):
#         if a != b:
#             top = [notes[(7+a*i) % len(notes)] for i in range(6)]
#             btm = [notes[(b*i) % len(notes)] for i in range(6)]
#             if (set(top + btm) == set(notes)) and (len(top + btm) == len(notes)):
#                 print(a, b)

# 1, 2, 5, 7, 10, 11

def display(arr):
    arr = [notes[x] for x in arr]
    arr = [str(x) for x in arr]
    btm, top = arr[:6], arr[6:]
    print(" " + " ".join(top))
    print(" ".join(btm))
    print()


for X in range(13):

    top = [(1+X*i) % len(notes) for i in range(12)]
    btm = [(X*i) % len(notes) for i in range(12)]

    if len(set(btm)) == 12:
        print(f"S {X}")
        display(btm[:6] + btm[6:])
    elif len(set(btm + top)) == 12:
        print(f"D {X}")
        display(btm[:6] + top[:6])


# assert set(top + btm) == set(notes), "missing notes"
# assert len(top + btm) == len(notes), "not the right length"


# 3 9 8 2  1  7
# 0 6 5 11 10 4
