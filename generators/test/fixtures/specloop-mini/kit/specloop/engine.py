import os

# os.environ.get("COMMENTED_OUT") is only mentioned in a comment.
def root():
    if os.environ.get("CLAUDE_PROJECT_DIR"):
        return os.environ["CLAUDE_PROJECT_DIR"]
    return os.getenv('MINI_GETENV', "x")

def disabled():
    return os.environ.get("MINI_DISABLED") == "1" or os.environ.get("CI")

env = dict(os.environ, SET_NOT_READ="1")
other = environ.get ( "BARE_ENVIRON" )
