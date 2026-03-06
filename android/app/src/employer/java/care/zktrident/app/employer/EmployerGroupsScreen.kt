package care.zktrident.app.employer

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployerGroupsScreen(viewModel: EmployerDashboardViewModel, onBack: () -> Unit) {
    val groups by viewModel.groups.collectAsState()
    var showCreate by remember { mutableStateOf(false) }
    var groupId by remember { mutableStateOf("") }
    var planId by remember { mutableStateOf("") }
    var effectiveDate by remember { mutableStateOf("") }
    var cap by remember { mutableStateOf("0") }

    LaunchedEffect(Unit) { viewModel.refreshGroups() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Groups") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
                actions = { TextButton(onClick = { showCreate = true }) { Text("+ New") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(groups) { group ->
                Card {
                    Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(group.groupId, style = MaterialTheme.typography.titleSmall)
                            Text(group.status)
                        }
                        Text("Plan: ${group.planId}")
                        Text("Effective: ${group.effectiveDate}")
                        Text("Enrolled: ${group.enrolledCount}/${if (group.enrollmentCap > 0) group.enrollmentCap else "unlimited"}")
                    }
                }
            }
        }
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("Create Group") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = groupId, onValueChange = { groupId = it }, label = { Text("Group ID") })
                    OutlinedTextField(value = planId, onValueChange = { planId = it }, label = { Text("Plan ID") })
                    OutlinedTextField(value = effectiveDate, onValueChange = { effectiveDate = it }, label = { Text("Effective Date (CCYYMMDD)") })
                    OutlinedTextField(value = cap, onValueChange = { cap = it }, label = { Text("Enrollment Cap (0=unlimited)") })
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.createGroup(groupId, planId, effectiveDate, cap.toIntOrNull() ?: 0)
                    showCreate = false
                }) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { showCreate = false }) { Text("Cancel") } },
        )
    }
}
