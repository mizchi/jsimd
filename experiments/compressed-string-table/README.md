# CompressedStringTable experiment

The suite stores 65,536 generated paths with block-local common prefixes. It compares 4,096 mixed
hit/miss equality queries and random materialization with byte arrays and pre-decoded strings.
Construction is excluded; encoded and uncompressed logical sizes are reported in the entrypoint
README.

Recorded on Apple M5 / Node 24.12: `equalsMany` took 0.0414 ms versus 0.0825 ms for scalar byte
equality and 0.0101 ms for pre-decoded string equality. Front-coded `get` took 1.2718 ms versus
0.1035 ms for byte-array slicing. The recorded layout occupied 31.0% of raw bytes.
