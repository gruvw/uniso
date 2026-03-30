notes = ["C ", "C#", "D ", "D#", "E ", "F ", "F#", "G ", "G#", "A ", "A#", "B "]

# for a in range(13):
#     for b in range(13):
#         if a != b:
#             top = [notes[(7+a*i) % len(notes)] for i in range(6)]
#             btm = [notes[(b*i) % len(notes)] for i in range(6)]
#             if (set(top + btm) == set(notes)) and (len(top + btm) == len(notes)):
#                 print(a, b)

# 1, 2, 5, 7, 10, 11

for X in range(13):

    top = [notes[(1+X*i) % len(notes)] for i in range(12)]
# top = [notes[(1+X*i) % len(notes)] for i in range(6)]
    btm = [notes[(X*i) % len(notes)] for i in range(12)]

    if len(set(btm + top)) == 12:
        print(X)

# print(" " + " ".join(top))
# print(" ".join(btm))

# assert set(top + btm) == set(notes), "missing notes"
# assert len(top + btm) == len(notes), "not the right length"
