extends "res://mcp_interaction_server.gd"
var responses: Array = []
func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
func _process(_delta: float) -> void:
	pass
func _send_response(data: Dictionary) -> void:
	responses.append(data)
