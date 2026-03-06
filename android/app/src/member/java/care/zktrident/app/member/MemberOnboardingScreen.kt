package care.zktrident.app.member

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import care.zktrident.app.BuildConfig
import care.zktrident.app.viewmodel.SequencerViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberOnboardingScreen(
    viewModel: MemberOnboardingViewModel,
    sequencerVm: SequencerViewModel,
    onComplete: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    if (state.complete) {
        LaunchedEffect(Unit) { onComplete() }
        return
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Member Enrollment") }) },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Progress indicator
            LinearProgressIndicator(
                progress = { (state.step + 1) / 6f },
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Step ${state.step + 1} of 6", style = MaterialTheme.typography.labelMedium)

            when (state.step) {
                0 -> TokenEntryStep(state, viewModel)
                1, 2 -> PhiCollectionStep(state, viewModel)
                3 -> KeyGenerationStep(state)
                4, 5 -> EnrollmentStep(state, viewModel, sequencerVm)
            }

            if (state.error != null) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Text(state.error!!, modifier = Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                }
            }
        }
    }
}

@Composable
private fun TokenEntryStep(state: MemberOnboardingViewModel.OnboardingState, vm: MemberOnboardingViewModel) {
    var tokenId by remember { mutableStateOf(state.tokenId) }

    Text("Enter your enrollment token", style = MaterialTheme.typography.titleMedium)
    Text("Your employer provided an enrollment token. Enter it below or scan the QR code.", style = MaterialTheme.typography.bodyMedium)

    OutlinedTextField(
        value = tokenId,
        onValueChange = { tokenId = it },
        label = { Text("Enrollment Token") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )

    Button(
        onClick = { vm.setTokenId(tokenId) },
        modifier = Modifier.fillMaxWidth(),
        enabled = tokenId.isNotBlank(),
    ) {
        Text("Continue")
    }
}

@Composable
private fun PhiCollectionStep(state: MemberOnboardingViewModel.OnboardingState, vm: MemberOnboardingViewModel) {
    var cardholderId by remember { mutableStateOf("") }
    var firstName by remember { mutableStateOf("") }
    var lastName by remember { mutableStateOf("") }
    var dob by remember { mutableStateOf("") }

    Text("Identity Verification", style = MaterialTheme.typography.titleMedium)
    Text(
        "This information is used locally to derive your wallet ID. " +
            "It is hashed immediately and NEVER transmitted.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    OutlinedTextField(value = cardholderId, onValueChange = { cardholderId = it }, label = { Text("Cardholder ID") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = firstName, onValueChange = { firstName = it }, label = { Text("First Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = lastName, onValueChange = { lastName = it }, label = { Text("Last Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(
        value = dob, onValueChange = { dob = it }, label = { Text("Date of Birth (CCYYMMDD)") },
        modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )

    Button(
        onClick = {
            vm.setPhi(cardholderId, firstName, lastName, dob)
            vm.generateKeyAndDeriveWallet()
        },
        modifier = Modifier.fillMaxWidth(),
        enabled = cardholderId.isNotBlank() && firstName.isNotBlank() && lastName.isNotBlank() && dob.length == 8,
    ) {
        Text("Generate Wallet")
    }
}

@Composable
private fun KeyGenerationStep(state: MemberOnboardingViewModel.OnboardingState) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text("Generating enrollment key and deriving wallet ID...", style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EnrollmentStep(
    state: MemberOnboardingViewModel.OnboardingState,
    vm: MemberOnboardingViewModel,
    sequencerVm: SequencerViewModel,
) {
    Text("Wallet Derived", style = MaterialTheme.typography.titleMedium)

    Card {
        Column(modifier = Modifier.padding(12.dp)) {
            Text("Wallet ID:", style = MaterialTheme.typography.labelSmall)
            Text(
                state.walletId?.take(20) + "...",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    if (state.enrolling) {
        CircularProgressIndicator(modifier = Modifier.padding(8.dp))
    } else {
        Button(
            onClick = { vm.completeEnrollment(BuildConfig.DEFAULT_SEQUENCER_URL) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Complete Enrollment")
        }
    }
}
